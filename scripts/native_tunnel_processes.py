"""Read-only native tunnel ownership for the PowerShell startup entrypoints.

No CIM, services, configuration, or process actions. Command lines are opt-in
private stdout captured by the PowerShell caller; diagnostics never include them.
"""
from pathlib import PureWindowsPath
import argparse, ctypes, json, socket, struct, sys, time
import windows_process_owner as native

PROTOCOL = 1
NAMES = frozenset(('tunnel-client.exe', 'webcodex.exe', 'webcodex-server.exe', 'bun.exe'))
READ_DELAYS = (.025, .075)


class NativeReadUnavailable(RuntimeError):
    pass


def _retry(read, sleep):
    for attempt in range(len(READ_DELAYS) + 1):
        try:
            return read()
        except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError):
            if attempt < len(READ_DELAYS): sleep(READ_DELAYS[attempt])
    raise NativeReadUnavailable('native_process_ownership_unavailable') from None


def _process_rows_once(names, pid, observe, identity):
    inventory = observe(target_names=names)
    if not isinstance(inventory, list): raise NativeReadUnavailable()
    rows = []; seen = set()
    for row in inventory:
        if (not isinstance(row, dict) or type(row.get('ProcessId')) is not int
                or not 0 <= row['ProcessId'] <= 0xffffffff or row['ProcessId'] in seen
                or not isinstance(row.get('ProcessName'), str) or not row['ProcessName']):
            raise NativeReadUnavailable()
        seen.add(row['ProcessId'])
        if row['ProcessName'] not in names or pid is not None and row['ProcessId'] != pid: continue
        if (row['ProcessId'] == 0 or type(row.get('ParentProcessId')) is not int
                or not 0 <= row['ParentProcessId'] <= 0xffffffff
                or any(not isinstance(row.get(field), str) or not row[field]
                       for field in ('ExecutablePath', 'CommandLine', 'CreationFiletime'))
                or not row['CreationFiletime'].isdecimal() or int(row['CreationFiletime']) <= 0
                or PureWindowsPath(row['ExecutablePath']).name.casefold() != row['ProcessName']):
            raise NativeReadUnavailable()
        current = identity(row['ProcessId'])
        if (current.get('ProcessId') != row['ProcessId'] or current.get('ProcessName') != row['ProcessName']
                or current.get('CreationFiletime') != row['CreationFiletime']):
            raise NativeReadUnavailable()
        rows.append({'ProcessId': row['ProcessId'], 'Name': row['ProcessName'],
                     'ParentProcessId': row['ParentProcessId'], 'ExecutablePath': row['ExecutablePath'],
                     'CommandLine': row['CommandLine'], 'CreationFiletime': row['CreationFiletime']})
    return rows


def process_rows(names, *, pid=None, observe=None, identity=None, sleep=time.sleep):
    """Complete named census and original creation recheck, never false-empty."""
    names = frozenset(names)
    if not names or not names <= NAMES or pid is not None and (type(pid) is not int or not 1 <= pid <= 0xffffffff):
        raise ValueError('invalid_native_process_query')
    observe = native.process_inventory if observe is None else observe
    identity = native.process_identity if identity is None else identity
    return _retry(lambda: _process_rows_once(names, pid, observe, identity), sleep)


def backend_listeners(*, observe=None, identity=None, api_factory=None, sleep=time.sleep):
    """Original single server's complete IPv4 loopback listeners, no NetTCPIP/WMI."""
    observe = native.process_inventory if observe is None else observe
    identity = native.process_identity if identity is None else identity
    api_factory = native._NativeApi if api_factory is None else api_factory
    def read():
        # This inner read is one observation; only the outer wrapper retries.
        rows = _process_rows_once({'webcodex-server.exe'}, None, observe, identity)
        if len(rows) != 1: raise NativeReadUnavailable()
        server = rows[0]; api = api_factory(); handle = api.open(server['ProcessId'])
        try:
            created = api.marker(handle); image = api.image(handle)
            if str(created) != server['CreationFiletime'] or image != server['ExecutablePath']: raise NativeReadUnavailable()
            buffer, size = api.tcp_table(2)
            # The shared bounded decoder validates every row, not only ours.
            native._decode_tcp_table(buffer, size, 2, 0)
            count = struct.unpack_from('<I', buffer)[0]; ports = set()
            for index in range(count):
                row = native._Tcp4.from_buffer_copy(buffer, 4 + index * ctypes.sizeof(native._Tcp4))
                if row.pid == server['ProcessId']: ports.add(socket.ntohs(row.local_port & 0xffff))
            listeners = []
            for port in sorted(ports):
                if not 1 <= port <= 65535: raise NativeReadUnavailable()
                listeners.extend(row for row in native._decode_tcp_table(buffer, size, 2, port)
                                 if row['OwningProcess'] == server['ProcessId'] and row['LocalAddress'] == '127.0.0.1')
            if api.marker(handle) != created or api.image(handle) != image: raise NativeReadUnavailable()
            return {'server': {key: value for key, value in server.items() if key != 'CommandLine'}, 'listeners': listeners}
        finally: api.close(handle)
    return _retry(read, sleep)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', action='append', choices=sorted(NAMES))
    parser.add_argument('--pid', type=int)
    parser.add_argument('--backend-listeners', action='store_true')
    parser.add_argument('--with-command-line', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.backend_listeners:
            if args.name or args.pid is not None or args.with_command_line: raise ValueError()
            payload = backend_listeners()
        else:
            rows = process_rows(args.name or {'tunnel-client.exe'}, pid=args.pid)
            if not args.with_command_line: rows = [{key: value for key, value in row.items() if key != 'CommandLine'} for row in rows]
            payload = {'rows': rows}
        print(json.dumps({'protocol': PROTOCOL, 'complete': True, **payload}, separators=(',', ':')))
        return 0
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError):
        print('native_process_ownership_unavailable', file=sys.stderr)
        return 2


if __name__ == '__main__': raise SystemExit(main())
