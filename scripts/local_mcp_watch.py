"""Small independent A/B connection watch; recovery stays in the original entry.

No model turns, business polling, task state changes, process stops or login
startup entries. A live but unavailable owner is retained for diagnosis.
"""
from pathlib import Path
import argparse, ctypes, hashlib, json, os, re, socket, struct, subprocess, sys, time, uuid
from datetime import datetime, timezone
from functools import lru_cache
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from bounded_process import run_bounded
from native_tunnel_processes import process_rows
from product_runtime import FileLease, ProductError, atomic_json, utc
from windows_process_owner import process_identity, _NativeApi, _decode_tcp_table
from web_host_launcher import resolve_powershell7
from webcodex_backend import processes as backend_processes, read_config as backend_config, normalized
from web_host_supervisor_owner import command_argv
from ingress_health import MAX_METRICS, TUNNEL, parse_metrics

OPENER = build_opener(ProxyHandler({}))
DELAYS = (5, 15, 60)


def source_signature(root):
    """Freeze the existing executable sources, without making a second release."""
    bridge = root / 'apps/codex-web-bridge'
    sources = list(bridge.glob('*.cjs')) + list((bridge / 'upstream/src').rglob('*.ts'))
    sources += [bridge / 'upstream/launcher/electron/atomic-file.cjs']
    sources += [root / 'scripts' / name for name in ('recover_local_mcp.ps1',
        'start_local_mcp_a.ps1', 'start_local_mcp_b.ps1', 'webcodex_backend.py',
        'native_tunnel_processes.py', 'local_mcp_watch.py', 'ingress_health.py',
        'local_mcp_credentials.ps1')]
    digest = hashlib.sha256()
    for item in sorted(set(sources)):
        digest.update(item.relative_to(root).as_posix().encode('utf8'))
        digest.update(b'\0'); digest.update(hashlib.sha256(item.read_bytes()).digest())
    return digest.hexdigest()


def read_json(path):
    if path.stat().st_size > 65536: raise ValueError('connection_metadata_invalid')
    return json.loads(path.read_text('utf-8-sig'))


def endpoint(value):
    uri = urlsplit(value)
    if (uri.scheme != 'http' or uri.hostname != '127.0.0.1' or not uri.port or
            uri.username or uri.password or uri.query or uri.fragment):
        raise ValueError('connection_metadata_invalid')
    return value.rstrip('/')


def fetch(url, *, headers=None, data=None, maximum=65536):
    with OPENER.open(Request(url, headers=headers or {}, data=data,
                            method='POST' if data else 'GET'), timeout=3) as reply:
        raw = reply.read(maximum + 1)
        if len(raw) > maximum: raise ValueError('connection_health_invalid')
        return raw.decode('utf8')


def original_backend(root, observe=backend_processes):
    config = backend_config(root / '.local/web-host/backend-launch.json')
    result = {}; identities={}
    for row in observe():
        role = 'runner' if row['Name'] == 'webcodex-runner.exe' else 'server'
        if normalized(row['ExecutablePath']) != normalized(config[role]): continue
        if role == 'runner':
            argv = command_argv(row['CommandLine'])
            references = [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == '--config']
            references += [arg.removeprefix('--config=') for arg in argv if arg.startswith('--config=')]
            if len(references) != 1 or normalized(references[0]) != normalized(config['runner_config']): continue
        if role in result: raise ValueError('backend_owner_ambiguous')
        result[role] = row['ProcessId']
        identities[role]={'pid':row['ProcessId'],'creation_filetime':row['CreationFiletime']}
    result['identities']=identities
    return result


def proxy_ready():
    try:
        with socket.create_connection(('127.0.0.1', 17890), timeout=1): return True
    except OSError: return False


@lru_cache(maxsize=1)
def boot_identity():
    """Native kernel boot token/time, cached once in each observer process."""
    api=ctypes.WinDLL('ntdll'); query=api.NtQuerySystemInformation
    query.argtypes=[ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(ctypes.c_uint32)]
    query.restype=ctypes.c_int32
    environment=ctypes.create_string_buffer(32); times=ctypes.create_string_buffer(48); length=ctypes.c_uint32()
    if query(90,environment,len(environment),ctypes.byref(length)) or length.value!=32:
        raise RuntimeError('boot_identity_unavailable')
    token=environment.raw[:16].hex()
    if not any(environment.raw[:16]) or query(3,times,len(times),ctypes.byref(length)) or length.value!=48:
        raise RuntimeError('boot_identity_unavailable')
    boot,current=struct.unpack_from('<QQ',times)
    if not 0<boot<=current: raise RuntimeError('boot_identity_unavailable')
    return {'boot_id':token,'boot_filetime':str(boot)}


def recovery_idle(root):
    """Observe the original entry's mutex without waiting or spending a retry."""
    name='Local\\CLW-LocalMCP-Recovery-'+hashlib.sha256(str(root).lower().encode('utf8')).hexdigest()[:16].upper()
    api=ctypes.WinDLL('kernel32', use_last_error=True)
    api.CreateMutexW.argtypes=[ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    api.CreateMutexW.restype=ctypes.c_void_p
    api.WaitForSingleObject.argtypes=[ctypes.c_void_p, ctypes.c_uint32]
    api.ReleaseMutex.argtypes=[ctypes.c_void_p]; api.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=api.CreateMutexW(None, False, name)
    if not handle: raise RuntimeError('recovery_lock_unavailable')
    try:
        state=api.WaitForSingleObject(handle, 0)
        if state == 258: return False
        if state not in (0, 128): raise RuntimeError('recovery_lock_unavailable')
        if not api.ReleaseMutex(handle): raise RuntimeError('recovery_lock_unavailable')
        return True
    finally: api.CloseHandle(handle)


def logical_owners(root, observe=process_rows):
    """Exact profile/script owners from a complete native creation snapshot."""
    owners={name:[] for name in ('union','A','B','desktop_A')}
    def values(argv, key):
        return [argv[i+1] for i, value in enumerate(argv[:-1]) if value == key] + [value[len(key)+1:] for value in argv if value.startswith(key+'=')]
    union=normalized(root/'apps/codex-web-bridge/serve-union.cjs')
    a=normalized(root/'.local/account-a-tunnel/profile.yaml')
    b=normalized(root/'.local/account-b-tunnel/profiles')
    desktop=normalized(Path(os.environ.get('LOCALAPPDATA',''))/'dev.webcodex.desktop/runtime/local/regular-tunnel-runtime')
    for row in observe({'bun.exe','tunnel-client.exe'}):
        argv=command_argv(row['CommandLine']); role=None; verified=True
        if row['Name'] == 'bun.exe' and union in [normalized(value) for value in argv]:
            role='union'
            verified=(normalized(root/'.local/codex-web-bridge/union-config.json') in [normalized(value) for value in argv]
                and normalized(row['ExecutablePath'])==normalized(root/'.local/runtimes/bun-1.4.0/bun.exe'))
        if row['Name'] == 'tunnel-client.exe':
            profiles=values(argv,'--profile-file'); names=values(argv,'--profile'); directories=values(argv,'--profile-dir')
            if a in [normalized(value) for value in profiles]:
                role='A'; verified=len(profiles)==1 and normalized(row['ExecutablePath'])==normalized(Path(os.environ.get('LOCALAPPDATA',''))/'WebCodex/tools/tunnel-client/0.0.12/windows-amd64/tunnel-client.exe')
            elif 'webcodex-account-b' in names and b in [normalized(value) for value in directories]:
                role='B'; binary=read_json(root/'.local/codex-web-bridge/settings.json')['tunnel']['binaryPath']
                verified=names==['webcodex-account-b'] and len(directories)==1 and normalized(row['ExecutablePath'])==normalized(binary)
            elif len(profiles)==1 and normalized(profiles[0]).startswith(desktop+'/'): role='desktop_A'
        if role:
            verified=verified and 'run' in argv[1:]
            owners[role].append({'pid':row['ProcessId'],'creation_filetime':row['CreationFiletime'],'configuration_verified':verified})
    return owners


def listener_owned(origin, owner):
    """Bind a health URL to its current exact native owner, never an old file."""
    api=_NativeApi(); buffer,size=api.tcp_table(2)
    listeners=_decode_tcp_table(buffer,size,2,urlsplit(origin).port)
    matching=[row for row in listeners if row['LocalAddress'] in ('127.0.0.1','0.0.0.0')]
    if owner is None:
        v6,size6=api.tcp_table(23)
        other=_decode_tcp_table(v6,size6,23,urlsplit(origin).port)
        return not matching and not any(row['LocalAddress'] in ('::','::1','::ffff:127.0.0.1') for row in other)
    if len(matching)!=1 or matching[0]['OwningProcess'] != owner['pid']: return False
    current=process_identity(owner['pid'])
    return current['CreationFiletime']==owner['creation_filetime']


def backend_port_readiness(root, backend=None):
    """Probe only an absent original Server; binding never opens a listener."""
    backend = original_backend(root) if backend is None else backend
    if backend.get('server'): return True, 'original_server_live'
    origin = endpoint(backend_config(root / '.local/web-host/backend-launch.json')['origin'])
    if not listener_owned(origin, None): return False, 'owner_changed'
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if os.name == 'nt': probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try: probe.bind(('127.0.0.1', urlsplit(origin).port))
        except OSError: return False, 'backend_port_waiting'
    return True, 'backend_port_ready'


def preboot_service_evidence(root, receipt=None, *, boot_fn=boot_identity, owners_fn=logical_owners,
        backend_fn=original_backend, listener_fn=listener_owned, coordinator_fn=process_identity,
        snapshot_fn=lambda:_NativeApi().snapshot(), origin_fn=lambda root:backend_config(root/'.local/web-host/backend-launch.json')['origin']):
    """Only a positively ended prior kernel boot can release service startup."""
    receipt=read_json(root/'.local/ab-recovery.json') if receipt is None else receipt
    if (receipt.get('launch_unknown') is not True or receipt.get('protocol')!=1 or
            type(receipt.get('model_sends')) is not int or receipt['model_sends']!=0 or
            receipt.get('business_state_changed') is not False): return None
    current=boot_fn(); prior=receipt.get('boot'); legacy=prior is None
    if legacy:
        started=datetime.fromisoformat(receipt['started_at'])
        if started.tzinfo is None: return None
        started_filetime=int((started.astimezone(timezone.utc)-datetime(1601,1,1,tzinfo=timezone.utc)).total_seconds()*10000000)
        if not 0<started_filetime<int(current['boot_filetime']): return None
    elif prior.get('boot_id')==current['boot_id'] or not re.fullmatch('[a-f0-9]{32}',prior.get('boot_id','')):
        return None
    coordinator=receipt.get('coordinator')
    if coordinator is not None:
        pid=coordinator.get('ProcessId'); creation=coordinator.get('CreationFiletime')
        if type(pid) is not int or not isinstance(creation,str) or not creation.isdecimal(): return None
        if pid in snapshot_fn() and coordinator_fn(pid)['CreationFiletime']==creation: return None
    elif not legacy: return None
    owners=owners_fn(root); backend=backend_fn(root)
    if any(owners.values()) or backend.get('server') or backend.get('runner'): return None
    if not listener_fn('http://127.0.0.1:18945',None) or not listener_fn(endpoint(origin_fn(root)),None): return None
    return {'run_id':receipt['run_id'],'state':'preboot_ended','prior_boot_id':None if legacy else prior['boot_id'],
        'boot_id':current['boot_id'],'boot_filetime':current['boot_filetime'],
        'legacy_started_before_boot':legacy,'coordinator_ended':True,'service_owners_absent':True,'fixed_listeners_absent':True}


def original_preboot_evidence(root):
    path=root/'.local/ab-recovery.json'
    return preboot_service_evidence(root,read_json(path)) if path.exists() else None


def inspect(root, *, read=fetch, backend=original_backend, owners_fn=logical_owners, listener_fn=listener_owned, clock=time.time):
    """Public transport health plus one compact read of the original Runner."""
    home = root / '.local/codex-web-bridge'
    saved = read_json(home / 'shared-entry.json')
    config = read_json(home / 'union-config.json')
    a_owner = read_json(root / '.local/account-a-tunnel/owner.json')
    base = endpoint(saved['url'].removesuffix('/mcp'))
    if config['port'] != 18945 or base != 'http://127.0.0.1:18945':
        raise ValueError('connection_metadata_invalid')
    if endpoint(config['target']) != endpoint(saved['upstream']):
        raise ValueError('connection_metadata_invalid')
    result = {'healthy': True, 'components': {}, 'owners': {
        'union': saved['unionPid'], 'A': a_owner['pid'], 'B': saved['tunnelPid']}}
    actual=owners_fn(root); result['owner_identities']=actual
    owned_backend = backend(root)
    result['backend_identities']=owned_backend.get('identities',{})
    result['owners'].update({'Runner': owned_backend.get('runner'), 'Server': owned_backend.get('server')})
    result['components']['Server'] = 'ready' if owned_backend.get('server') else 'unavailable'
    if not owned_backend.get('server'): result['healthy'] = False
    health_origins={}
    for name in ('union', 'A', 'B'):
        try:
            if len(actual[name])>1 or name=='A' and actual['A'] and actual['desktop_A']:
                result['components'][name]='owner_ambiguous'; result['healthy']=False; continue
            if not actual[name]:
                if name=='union' and not listener_fn(base,None):
                    result['components'][name]='owner_changed'; result['healthy']=False; continue
                result['components'][name]='desktop_handoff' if name=='A' and actual['desktop_A'] else 'unavailable'
                result['healthy']=False; continue
            owner=actual[name][0]
            if owner.get('configuration_verified') is False or owner['pid'] != result['owners'][name]:
                result['components'][name]='owner_changed'; result['healthy']=False; continue
            if name == 'union':
                health_origins[name]=base
                if not listener_fn(base,owner): raise ValueError('connection_listener_owner_changed')
                data = json.loads(read(base + '/healthz'))
                if data.get('service') != 'clw-mcp-union' or data.get('pid') != saved['unionPid']:
                    result['components'][name] = 'owner_changed'; result['healthy'] = False; continue
            else:
                ref = root / ('.local/account-' + name.lower() + '-tunnel/health-url.txt')
                origin = endpoint(ref.read_text('utf8').strip())
                health_origins[name]=origin
                if urlsplit(origin).path not in ('', '/'):
                    raise ValueError('connection_metadata_invalid')
                if not listener_fn(origin,owner): raise ValueError('connection_listener_owner_changed')
                if read(origin + '/healthz').strip() != 'live' or read(origin + '/readyz').strip() != 'ready':
                    result['components'][name] = 'not_ready'; result['healthy'] = False; continue
                tunnel_id = a_owner.get('tunnelId') if name == 'A' else read_json(home / 'settings.json').get('tunnel', {}).get('tunnelId')
                if not isinstance(tunnel_id, str) or not TUNNEL.fullmatch(tunnel_id):
                    raise ValueError('connection_metadata_invalid')
                observed = clock()
                poll = parse_metrics(read(origin + '/metrics', maximum=MAX_METRICS), tunnel_id, observed)
                # Local readiness and an old successful poll survive upstream
                # authentication loss. Only a recent successful poll is ready.
                last = poll['last_poll_at']
                age = max(0, observed - last) if last else None
                result.setdefault('tunnel_polls', {})[name] = {'last_poll_at': last, 'age_seconds': age}
                if not last or age > 90:
                    result['components'][name] = 'poll_not_seen' if not last else 'poll_stale'
                    result['healthy'] = False; continue
            result['components'][name] = 'ready'
        except (OSError, ValueError, URLError):
            result['components'][name] = 'unavailable'; result['healthy'] = False
    if result['components'].get('union') == 'ready' and owned_backend.get('server'):
        headers = {'authorization': Path(config['authorizationFile']).read_text('utf8').strip(),
            'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call', 'mcp-name': 'runtime_status'}
        try:
            request = {'jsonrpc': '2.0', 'id': 'local-connection-watch-' + uuid.uuid4().hex,
                'method': 'tools/call', 'params': {'name': 'runtime_status', 'arguments': {'compact': True},
                '_meta': {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                          'io.modelcontextprotocol/clientCapabilities': {}}}}
            reply = json.loads(read(base + '/mcp', headers=headers,
                                    data=json.dumps(request).encode('utf8')))
            content = reply.get('result', {}).get('structuredContent', {})
            output = content.get('output', {}); layers = output.get('connection_layers', {})
            runner = layers.get('runner_process', {}); transport = layers.get('server_transport', {})
            age = transport.get('age_secs'); registry = layers.get('project_registry', {})
            connected = (content.get('success') is True and owned_backend.get('runner') and
                         runner.get('status') == 'ready' and transport.get('status') == 'connected' and
                         isinstance(age, (int, float)) and not isinstance(age, bool) and 0 <= age <= 60 and
                         output.get('agents', {}).get('online_count', 0) > 0 and registry.get('online_projects', 0) > 0)
            result['runner'] = {'status': runner.get('status'), 'transport': transport.get('status'),
                'heartbeat_age_seconds': transport.get('age_secs'), 'observed_at': transport.get('observed_at'),
                'agent_instance_id': runner.get('agent_instance_id'),
                'online_projects': layers.get('project_registry', {}).get('online_projects'),
                'active_jobs': output.get('jobs', {}).get('active_count')}
            result['server_transport'] = {key: transport.get(key) for key in
                ('status', 'age_secs', 'observed_at', 'last_heartbeat_at', 'connected_at',
                 'connection_instance', 'reason_code')}
            result['components']['Runner'] = 'ready' if connected else 'connection_wait'
            if not connected: result['healthy'] = False
        except (OSError, ValueError, URLError) as error:
            # A deadline or unreadable reply says nothing about whether the
            # held Runner process/connection died. Keep its identity and let
            # the next normal watch sample observe it; never launch a retry.
            result['components']['Runner'] = 'observation_unavailable'; result['healthy'] = False
            result['runner_observation'] = {'status':'unavailable','reason':
                'runner_probe_timeout' if isinstance(error,TimeoutError) or
                isinstance(getattr(error,'reason',None),TimeoutError) else 'runner_probe_unavailable'}
        finally:
            headers.clear()
    for name, origin in health_origins.items():
        if result['components'][name]=='ready' and not listener_fn(origin,actual[name][0]):
            result['components'][name]='unavailable'; result['healthy']=False
    return result


def recovery_eligibility(root, health, *, observe=process_rows):
    """Positive native absence only. The launcher repeats its own held checks."""
    if 'owner_changed' in health['components'].values(): return False, 'owner_changed'
    owners=logical_owners(root, observe=observe)
    if any(len(values)>1 for values in owners.values()) or owners['A'] and owners['desktop_A']:
        return False, 'owner_ambiguous'
    if any(row.get('configuration_verified') is False for values in owners.values() for row in values):
        return False, 'owner_changed'
    backend_unready = [name for name in ('Server', 'Runner')
        if name in health['components'] and health['components'][name] != 'ready']
    if backend_unready:
        backend = original_backend(root)
        for name in backend_unready:
            if backend.get(name.lower()):
                return False, 'runner_connection_wait' if name == 'Runner' else 'live_owner_unavailable'
        if 'Server' in backend_unready:
            ready, reason = backend_port_readiness(root, backend)
            if not ready: return False, reason
        # A tunnel's one-time initialize can be unready because its backend is
        # gone. The original entry prepares the missing backend first and
        # retains exact live tunnel/Union owners; it never restarts them here.
        return True, 'original_backend_absent'
    for name, state in health['components'].items():
        if state == 'ready': continue
        if owners.get(name): return False, 'live_owner_unavailable'
    return True, 'original_owner_absent'


def recover(root, shell):
    run_id=uuid.uuid4().hex
    try:
        result = run_bounded([shell, '-NoLogo', '-NoProfile', '-File',
            str(root / 'scripts/recover_local_mcp.ps1'), '-PythonExecutable', sys.executable,
            '-RecoveryRunId',run_id],
            # Server startup (25s), cold Runner registration (180s), then the
            # existing bounded tunnel launches/verification share this ceiling.
            timeout=360, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try: receipt=read_json(root/('.local/ab-recovery-'+run_id+'.json'))
        except (OSError,ValueError,KeyError):
            return {'complete':False,'success':False,'reason':'original_recovery_completion_unknown'}
        if receipt.get('run_id')!=run_id or receipt.get('launch_unknown') is not False:
            return {'complete':False,'success':False,'reason':'original_recovery_completion_unknown'}
        if receipt.get('state')=='waiting_backend' and receipt.get('error_code')=='backend_port_waiting':
            return {'complete':True,'success':False,'reason':'backend_port_waiting'}
        success=result.returncode==0 and receipt.get('state')=='completed'
        return {'complete': True, 'success': success,
                'reason': 'recovered' if success else 'original_recovery_failed'}
    except subprocess.TimeoutExpired:
        return {'complete': False, 'success': False, 'reason': 'original_recovery_completion_unknown'}
    except (ValueError,KeyError):
        return {'complete':False,'success':False,'reason':'original_recovery_completion_unknown'}
    except OSError:
        return {'complete': True, 'success': False, 'reason': 'original_recovery_start_failed'}


def original_recovery_unknown(root):
    path=root/'.local/ab-recovery.json'
    if not path.exists(): return False
    receipt=read_json(path)
    if receipt.get('launch_unknown') is not True: return None
    run_id=receipt.get('run_id')
    if not isinstance(run_id,str) or not re.fullmatch('[a-f0-9]{32}',run_id):
        raise ValueError('recovery_receipt_identity_unknown')
    return run_id


class ConnectionWatch:
    def __init__(self, root, signature, *, inspect_fn=inspect, eligible_fn=recovery_eligibility,
                 recover_fn=recover, signature_fn=source_signature, vpn_fn=proxy_ready,
                 idle_fn=recovery_idle, unknown_fn=original_recovery_unknown, now=time.monotonic, shell=None):
        self.root = root; self.signature = signature; self.inspect = inspect_fn
        self.eligible = eligible_fn; self.recover = recover_fn; self.signature_fn = signature_fn
        self.now = now; self.shell = shell; self.attempts = 0; self.next_attempt = 0
        self.completion_unknown = False; self.recoveries = 0
        self.vpn=vpn_fn; self.idle=idle_fn; self.waited_for_vpn=False; self.owner_state=None
        self.unknown=unknown_fn
        self.settled_unknown=None
        self.preboot=original_preboot_evidence; self.preboot_ended=None

    def tick(self):
        try:
            if not self.vpn():
                self.waited_for_vpn=True
                return {'state':'waiting_vpn','reason':'vpn_proxy_unavailable','healthy':False,
                    'attempts':self.attempts,'recoveries':self.recoveries,
                    'recovery_completion_unknown':self.completion_unknown,'settled_recovery_run_id':self.settled_unknown}
            health = self.inspect(self.root)
            result = {**health, 'state': 'healthy' if health['healthy'] else 'needs_attention',
                      'attempts': self.attempts, 'recoveries': self.recoveries,
                      'recovery_completion_unknown':self.completion_unknown,
                      'settled_recovery_run_id':self.settled_unknown}
            if health['healthy']:
                unknown=self.unknown(self.root)
                if unknown: self.settled_unknown=unknown; result['settled_recovery_run_id']=unknown
                self.attempts = 0; self.next_attempt = 0; self.completion_unknown = False
                result['attempts'] = 0; result['recovery_completion_unknown']=False; return result
            if not self.idle(self.root):
                result['state']='waiting_original_recovery'; result['reason']='original_recovery_in_progress'; return result
            unknown=self.unknown(self.root)
            if unknown and unknown!=self.settled_unknown:
                ended=self.preboot(self.root)
                if ended and ended['run_id']==unknown:
                    self.preboot_ended=ended;self.settled_unknown=unknown;self.completion_unknown=False
                    result['settled_recovery_run_id']=unknown;result['preboot_ended']=ended
                else: self.completion_unknown=True
            if self.completion_unknown:
                result['recovery_completion_unknown']=True
                result['reason']='original_recovery_completion_unknown'; return result
            if self.waited_for_vpn:
                self.attempts=0;self.next_attempt=0;result['attempts']=0
            self.waited_for_vpn=False
            owner_state=json.dumps({'backend':health.get('backend_identities',{
                name:health['owners'].get(name) for name in ('Server','Runner')}),
                'identities':health.get('owner_identities')},sort_keys=True)
            if self.owner_state is not None and self.owner_state!=owner_state:
                self.attempts=0; self.next_attempt=0; result['attempts']=0
            self.owner_state=owner_state
            allowed, reason = self.eligible(self.root, health)
            result['reason'] = reason
            if reason == 'backend_port_waiting': result['state'] = 'waiting_backend'
            if not allowed: return result
            if self.signature_fn(self.root) != self.signature:
                result['reason'] = 'source_changed_restart_watch_after_verification'; return result
            if self.attempts >= len(DELAYS):
                result['reason'] = 'recovery_retry_limit'; return result
            if self.now() < self.next_attempt:
                result['state'] = 'recovery_backoff'; return result
            self.attempts += 1
            recovered = self.recover(self.root, self.shell)
            if recovered['complete'] and recovered['reason'] == 'backend_port_waiting':
                self.attempts -= 1
                return {**result, 'state':'waiting_backend', 'reason':'backend_port_waiting', 'attempts':self.attempts}
            self.completion_unknown = not recovered['complete']
            if recovered['success']: self.recoveries += 1
            self.next_attempt = self.now() + DELAYS[self.attempts - 1]
            return {**result, 'state': 'recovering' if recovered['success'] else 'needs_attention',
                    'reason': recovered['reason'], 'attempts': self.attempts,
                    'recoveries': self.recoveries, 'recovery_completion_unknown': self.completion_unknown}
        except (OSError, ValueError, KeyError, RuntimeError, TypeError):
            return {'state': 'needs_attention', 'reason': 'connection_observation_unavailable',
                    'healthy': False, 'attempts': self.attempts, 'recoveries': self.recoveries,
                    'recovery_completion_unknown':self.completion_unknown,'settled_recovery_run_id':self.settled_unknown}


def record(home, value, previous):
    atomic_json(home / 'status.json', value)
    key = (value.get('state'), value.get('reason'), value.get('attempts'),
           json.dumps(value.get('owners'), sort_keys=True))
    if key != previous:
        journal = home / 'events.jsonl'
        if journal.exists() and journal.stat().st_size > 128 * 1024:
            os.replace(journal, home / 'events.previous.jsonl')
        with journal.open('a', encoding='utf8') as output:
            output.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    return key


def existing(root):
    try:
        status = read_json(root / '.local/local-mcp-watch/status.json')
        identity = process_identity(status['pid'])
        active = (status.get('state') != 'stopped' and
                  identity['CreationFiletime'] == status['creation_filetime'] and
                  identity['ProcessName'] in ('python.exe', 'pythonw.exe'))
        return {'active': active, 'pid': status['pid'] if active else None,
                'source_sha': status.get('source_sha') if active else None}
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        return {'active': False, 'pid': None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--signature', action='store_true')
    parser.add_argument('--existing', action='store_true')
    parser.add_argument('--source-sha')
    args = parser.parse_args(argv); root = args.root.resolve()
    if args.existing:
        print(json.dumps(existing(root))); return 0
    if args.signature:
        print(source_signature(root)); return 0
    if not 5 <= args.interval <= 300 or not re.fullmatch('[a-f0-9]{64}', args.source_sha or ''):
        raise ValueError('invalid_connection_watch_options')
    home = root / '.local/local-mcp-watch'; home.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex; started = utc(); previous = None
    try:
        with FileLease(home / 'watch.lock'):
            identity = process_identity(os.getpid())
            watch = ConnectionWatch(root, args.source_sha, shell=resolve_powershell7())
            if not watch.shell: raise ValueError('powershell7_missing')
            prior=read_json(home/'status.json') if (home/'status.json').exists() else {}
            # A verified source replacement still owns the original unknown
            # recovery. Only fully healthy observations can settle that state.
            watch.completion_unknown=(prior.get('recovery_completion_unknown') is True or
                prior.get('reason')=='original_recovery_completion_unknown')
            watch.settled_unknown=prior.get('settled_recovery_run_id')
            watch.preboot_ended=prior.get('preboot_ended')
            latest=read_json(root/'.local/ab-recovery.json') if (root/'.local/ab-recovery.json').exists() else {}
            ended=latest.get('prior_service_startup') or {}
            if (ended.get('state')=='preboot_ended' and ended.get('boot_id')==boot_identity()['boot_id'] and
                    str(prior.get('creation_filetime','')).isdecimal() and
                    int(prior['creation_filetime'])<int(boot_identity()['boot_filetime'])):
                watch.completion_unknown=False;watch.settled_unknown=ended['run_id'];watch.preboot_ended=ended
            while True:
                value = {**watch.tick(), 'at': utc(), 'started_at': started,
                    'run_id': run_id, 'pid': os.getpid(),
                    'creation_filetime': identity['CreationFiletime'],
                    'source_sha': args.source_sha, 'interval_seconds': args.interval,
                    'recovery_completion_unknown':watch.completion_unknown,'settled_recovery_run_id':watch.settled_unknown,
                    'preboot_ended':watch.preboot_ended,
                    'model_sends': 0, 'business_state_changed': False}
                previous = record(home, value, previous)
                for _ in range(args.interval):
                    time.sleep(1)
                    try: stopping = read_json(home / 'stop.json').get('run_id') == run_id
                    except (OSError, ValueError): stopping = False
                    if stopping:
                        record(home, {**value, 'at': utc(), 'state': 'stopped'}, previous); return 0
    except ProductError:
        # The original watcher keeps its kernel-held lock. Never stop it or
        # overwrite its status merely because another StartWatch was clicked.
        return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError):
        print('Connection watch unavailable; original services retained.', file=sys.stderr)
        sys.exit(1)
