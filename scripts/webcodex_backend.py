"""Start installed WebCodex services without the Desktop UI or new configuration.

The local manifest contains only paths and the loopback origin. Existing services
are never stopped; credentials remain in their original env/config files.
"""
from pathlib import Path
import json, os, re, subprocess, time
from contextlib import ExitStack
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from product_runtime import FileLease, atomic_json
from bounded_process import run_bounded
from windows_process_owner import process_inventory, OwnershipUnavailable
from web_host_supervisor_owner import command_argv
from live_transport import NoRedirect, ObservationError, validate_origin, _runner_values

SERVER_READY_TIMEOUT = 25
BACKEND_PROCESS_NAMES = frozenset(('webcodex-server.exe', 'webcodex-runner.exe'))
PROCESS_READ_DELAYS = (.05, .2)
MCP_READY_PROTOCOL = '2025-06-18'
MCP_READY_MAX_BODY = 256 * 1024


class BackendStartupError(RuntimeError):
    def __init__(self, reason, started):
        super().__init__(reason)
        self.started = list(started)
        self.completion_unknown = True


def failure_code(error):
    # Support state contains fixed codes and our own launch roles/PIDs only.
    # No command arguments, captured output, env/config values or temp paths.
    if isinstance(error, subprocess.TimeoutExpired):
        return 'startup_timeout'
    known = {'backend_server_not_ready', 'backend_runner_exited',
        'backend_launch_manifest_missing',
        'mcp_startup_not_ready',
        'backend_manifest_version_invalid', 'backend_origin_must_be_loopback',
        'backend_process_identity_unknown', 'backend_endpoint_has_unverified_owner',
        'backend_multiple_owners:server', 'backend_multiple_owners:runner',
        *('backend_installed_file_missing:' + field for field in
          ('server', 'runner', 'cli', 'env_file', 'runner_config'))}
    return str(error) if isinstance(error, RuntimeError) and str(error) in known else 'startup_unavailable'


def processes(*, observe=None, sleep=time.sleep):
    """Stable native identities for the two services; read races never mean empty.

    The native reader also returns non-target PID metadata, but only these two
    names need held image/argv identities. Retry observations before any spawn;
    no service launch or CLI probe is repeated by this read-only recovery.
    """
    observe = process_inventory if observe is None else observe
    for attempt in range(len(PROCESS_READ_DELAYS) + 1):
        try:
            inventory = observe(target_names=BACKEND_PROCESS_NAMES)
            if not isinstance(inventory, list):
                raise OwnershipUnavailable()
            rows = []
            seen = set()
            for item in inventory:
                if (not isinstance(item, dict) or type(item.get('ProcessId')) is not int
                        or not 0 <= item['ProcessId'] <= 0xffffffff
                        or item['ProcessId'] in seen
                        or not isinstance(item.get('ProcessName'), str)
                        or not item['ProcessName']):
                    raise OwnershipUnavailable()
                seen.add(item['ProcessId'])
                name = item['ProcessName'].casefold()
                if name not in BACKEND_PROCESS_NAMES:
                    continue
                if (item['ProcessId'] == 0
                        or any(not isinstance(item.get(field), str) or not item[field]
                        for field in ('ExecutablePath', 'CommandLine', 'CreationFiletime'))
                        or not item['CreationFiletime'].isdecimal()
                        or int(item['CreationFiletime']) <= 0):
                    raise OwnershipUnavailable()
                rows.append({**item, 'Name': name})
            return rows
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            if attempt < len(PROCESS_READ_DELAYS):
                sleep(PROCESS_READ_DELAYS[attempt])
    error = RuntimeError('backend_process_identity_unknown')
    error.process_observation_attempts = len(PROCESS_READ_DELAYS) + 1
    raise error from None


def normalized(value):
    return str(value).removeprefix('\\\\?\\').replace('\\', '/').casefold()


def read_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    if config.get('version') != 1:
        raise RuntimeError('backend_manifest_version_invalid')
    for field in ('server', 'runner', 'cli', 'env_file', 'runner_config'):
        value = Path(config[field])
        if not value.is_absolute() or not value.is_file():
            raise RuntimeError('backend_installed_file_missing:' + field)
    origin = urlsplit(config['origin'])
    if (origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port
            or origin.path or origin.query or origin.fragment or origin.username):
        raise RuntimeError('backend_origin_must_be_loopback')
    return config


def ready(config, timeout=5):
    try:
        result = run_bounded([config['cli'], 'server', 'status', '--url', config['origin'],
            '--env-file', config['env_file'], '--no-system-proxy', '--json'],
            capture_stdout=True, text=True, encoding='utf-8', timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or result.stdout_truncated:
            return False
        status = json.loads(result.stdout)
        return (status.get('probe_url', '').rstrip('/') == config['origin']
                and status.get('http_reachable') is True
                and status.get('http_status_code') == 200
                and status.get('revision_check', '').startswith('ok:'))
    except subprocess.TimeoutExpired:
        # A wrapper deadline is an incomplete probe, not another not-ready
        # sample. Preserve it for startup classification; do not replay it.
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def _mcp_server_token(config):
    """Only the installed Server's already selected env reference is used."""
    path=Path(config['env_file'])
    if path.stat().st_size>65536:raise RuntimeError('mcp_startup_not_ready')
    found=[]
    for raw in path.read_text(encoding='utf-8-sig').splitlines():
        line=raw.strip()
        if line.startswith('export '):line=line[7:].lstrip()
        if '=' not in line or line.startswith('#'):continue
        key,value=line.split('=',1)
        if key.strip()!='WEBCODEX_TOKEN':continue
        value=value.strip()
        if value.startswith('"'):value=json.loads(value)
        elif value.startswith("'") and value.endswith("'"):value=value[1:-1]
        found.append(value)
    if (len(found)!=1 or not isinstance(found[0],str) or not 20<=len(found[0])<=4096
            or any(ord(c)<33 or ord(c)>126 for c in found[0])):
        raise RuntimeError('mcp_startup_not_ready')
    return found[0]


def _mcp_initialize_response(response,request_id,deadline):
    content_type=response.headers.get('Content-Type','').split(';',1)[0].strip().lower()
    used=0;chunks=[];buffer=b'';data=[]
    read=getattr(response,'read1',response.read)
    while used<=MCP_READY_MAX_BODY:
        remaining=deadline-time.monotonic()
        if remaining<=0:return None
        socket=getattr(getattr(getattr(response,'fp',None),'raw',None),'_sock',None)
        if socket is not None:socket.settimeout(remaining)
        raw=read(min(4096,MCP_READY_MAX_BODY-used+1));used+=len(raw)
        if time.monotonic()>=deadline:return None
        if used>MCP_READY_MAX_BODY:return None
        if not raw:
            return None if content_type=='text/event-stream' else json.loads(b''.join(chunks))
        if content_type!='text/event-stream':chunks.append(raw);continue
        # Read chunks against one aggregate deadline; frequent SSE keepalives
        # must not extend the socket's per-read timeout forever.
        buffer+=raw
        while b'\n' in buffer:
            raw_line,buffer=buffer.split(b'\n',1);line=raw_line.decode('utf-8').strip()
            if line.startswith('data:'):
                data.append(line[5:].lstrip())
                try:reply=json.loads('\n'.join(data))
                except ValueError:continue
                if isinstance(reply,dict) and reply.get('id')==request_id:return reply
            if not line:data=[]
    return None


def _union_mcp_scope(root,config):
    folder=Path(root)/'.local/codex-web-bridge'
    union=json.loads((folder/'union-config.json').read_text(encoding='utf-8-sig'))
    shared=json.loads((folder/'shared-entry.json').read_text(encoding='utf-8-sig'))
    upstream=validate_origin(config['origin'])+'/mcp';url='http://127.0.0.1:18945/mcp'
    if (type(union.get('port')) is not int or union['port']!=18945 or union.get('target')!=upstream
            or shared.get('url')!=url or shared.get('upstream')!=upstream):
        raise RuntimeError('mcp_startup_not_ready')
    auth=Path(union['authorizationFile'])
    if not auth.is_absolute() or not auth.is_file() or auth.stat().st_size>8192:
        raise RuntimeError('mcp_startup_not_ready')
    # The B launcher verifies the actual new/reused Union PID. Its old shared
    # receipt remains intact until the new B owner is accepted; do not gate on
    # that historical PID here or a cold startup could never complete.
    return url,auth


def mcp_ready(config, timeout=5, *, endpoint=None, authorization_file=None):
    """Read-only initialize of the exact native Server, not health/aliveness."""
    deadline=time.monotonic()+timeout
    try:
        origin=validate_origin(config['origin'])
        if authorization_file is None:
            url=origin+'/mcp';authorization='Bearer '+_mcp_server_token(config)
        else:
            url='http://127.0.0.1:18945/mcp'
            if endpoint!=url:raise RuntimeError('mcp_startup_not_ready')
            authorization=Path(authorization_file).read_text(encoding='utf-8-sig').strip()
            if not 20<=len(authorization)<=8192 or any(ord(c)<32 or ord(c)>126 for c in authorization):
                raise RuntimeError('mcp_startup_not_ready')
        request_id='clw-backend-readiness'
        body={'jsonrpc':'2.0','id':request_id,'method':'initialize','params':{
            'protocolVersion':MCP_READY_PROTOCOL,'capabilities':{},
            'clientInfo':{'name':'clw-backend-readiness','version':'1'}}}
        opener=build_opener(ProxyHandler({}),NoRedirect())
        request=Request(url,data=json.dumps(body).encode('utf-8'),method='POST',headers={
            'Authorization':authorization,'Content-Type':'application/json',
            'Accept':'application/json, text/event-stream','Mcp-Protocol-Version':MCP_READY_PROTOCOL,
            'Mcp-Method':'initialize'})
        remaining=deadline-time.monotonic()
        if remaining<=0:return False
        with opener.open(request,timeout=remaining) as response:
            if response.status!=200:return False
            reply=_mcp_initialize_response(response,request_id,deadline)
        if not isinstance(reply,dict) or reply.get('jsonrpc')!='2.0' or reply.get('id')!=request_id or reply.get('error') is not None:
            return False
        result=reply.get('result')
        return (isinstance(result,dict) and result.get('protocolVersion')==MCP_READY_PROTOCOL
                and isinstance(result.get('capabilities'),dict) and isinstance(result.get('serverInfo'),dict)
                and all(isinstance(result['serverInfo'].get(key),str) and result['serverInfo'][key]
                        for key in ('name','version')))
    except HTTPError as error:
        if error.code in (401,403):raise RuntimeError('mcp_startup_not_ready') from None
        return False
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, ObservationError):
        return False


def runner_ready(config, client_id, timeout=5):
    """Read the exact selected Runner; an unregistered client is a startup wait."""
    deadline=time.monotonic()+timeout
    request=Request(validate_origin(config['origin'])+'/api/runtime/status',method='POST',
        data=json.dumps({'client_id':client_id,'compact':False}).encode('utf-8'),
        headers={'Authorization':'Bearer '+_mcp_server_token(config),
            'Content-Type':'application/json','Accept':'application/json'})
    try:
        with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=timeout) as response:
            if response.status!=200:raise RuntimeError('mcp_startup_not_ready')
            reply=_mcp_initialize_response(response,None,deadline)
        if not isinstance(reply,dict) or reply.get('success') is not True:
            raise RuntimeError('mcp_startup_not_ready')
        output=reply.get('output')
        if not isinstance(output,dict):raise RuntimeError('mcp_startup_not_ready')
        focus=output.get('focus',{});agents=output.get('agents',{})
        if not isinstance(focus,dict) or not isinstance(agents,dict):raise RuntimeError('mcp_startup_not_ready')
        clients=agents.get('clients',[])
        if (not isinstance(clients,list) or len(clients)!=1 or not isinstance(clients[0],dict) or
                focus.get('client_id')!=client_id or clients[0].get('client_id')!=client_id):
            raise RuntimeError('mcp_startup_not_ready')
        age=clients[0].get('last_seen_age_secs')
        return (focus.get('connected') is True and clients[0].get('connected') is True and
            agents.get('online_count')==1 and isinstance(age,(int,float)) and not isinstance(age,bool)
            and 0<=age<=60 and time.monotonic()<deadline)
    except HTTPError as error:
        try:
            if error.code==400:
                reply=_mcp_initialize_response(error,None,deadline)
                if (isinstance(reply,dict) and reply.get('success') is False and
                        reply.get('error')=='unknown_client_id: no caller-visible Runner matches the exact client_id' and
                        reply.get('output')=={'error_kind':'unknown_client_id','client_id':client_id}):
                    return False
            if error.code in (502,503,504):return False
        finally:error.close()
        raise RuntimeError('mcp_startup_not_ready') from None
    except (OSError,ValueError,ObservationError):
        return False


def _mcp_server_identity(config):
    owners=[(row['ProcessId'],row['CreationFiletime']) for row in processes()
        if row['Name']=='webcodex-server.exe' and normalized(row['ExecutablePath'])==normalized(config['server'])]
    if len(owners)!=1:raise RuntimeError('mcp_startup_not_ready')
    return owners[0]


def wait_mcp_ready(root, timeout=30, *, union=False, require_runner=False, probe=None, sleep=time.sleep, now=time.monotonic):
    """Wait read-only for native MCP and, optionally, its exact original Runner."""
    try:
        timeout=float(timeout)
        if not 0<timeout<=300:raise RuntimeError('mcp_startup_not_ready')
        deadline=now()+timeout
        config=read_config(Path(root)/'.local/web-host/backend-launch.json')
        endpoint,auth=_union_mcp_scope(root,config) if union else (None,None)
        if require_runner:
            values=_runner_values(Path(config['runner_config']));client_id=values.get('client_id')
            if (validate_origin(values['server_url'])!=validate_origin(config['origin']) or
                    not isinstance(client_id,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',client_id)):
                raise RuntimeError('mcp_startup_not_ready')
            owner=_mcp_server_identity(config)
        attempts=0;mcp_observed=False
        while now()<deadline:
            attempts+=1
            if require_runner and _mcp_server_identity(config)!=owner:raise RuntimeError('mcp_startup_not_ready')
            remaining=deadline-now()
            if remaining<=0:break
            result=mcp_observed or (probe(config,timeout=min(5,remaining)) if probe is not None else
                    mcp_ready(config,timeout=min(5,remaining),**({'endpoint':endpoint,'authorization_file':auth} if union else {})))
            if result is True and now()<deadline:
                mcp_observed=True
                if not require_runner or runner_ready(config,client_id,timeout=min(5,deadline-now())):
                    if require_runner and _mcp_server_identity(config)!=owner:raise RuntimeError('mcp_startup_not_ready')
                    if now()<deadline:
                        return {'state':'ready','mcpReady':True,'attempts':attempts,'service_start_requested':False,
                            **({'runnerReady':True} if require_runner else {})}
            remaining=deadline-now()
            if remaining>0:sleep(min(2 if require_runner else .5,remaining))
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError,ObservationError):
        pass
    raise RuntimeError('mcp_startup_not_ready') from None


def launch(args, config, role):
    environment = os.environ.copy()
    for key in ('CONTROL_PLANE_API_KEY', 'CONTROL_PLANE_TUNNEL_ID', 'OPENAI_ADMIN_KEY', 'OPENAI_API_KEY'):
        environment.pop(key, None)
    environment['WEBCODEX_ENV_FILE'] = config['env_file']
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        environment[key] = 'http://127.0.0.1:17890'
    for key in ('NO_PROXY', 'no_proxy'):
        environment[key] = '127.0.0.1,localhost,::1'
    # No stdin-EOF lifetime flag: these are shared services, independent of a UI.
    with ExitStack() as logs:
        outputs = {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
        if config.get('diagnostic_home'):
            folder = Path(config['diagnostic_home']); folder.mkdir(parents=True, exist_ok=True)
            for stream in outputs:
                path = folder / (role + '.' + stream + '.log')
                # Rotate only before a confirmed missing owner is launched;
                # never rename or truncate a current shared process's stream.
                if path.exists() and path.stat().st_size > 1024 * 1024:
                    os.replace(path, folder / (role + '.' + stream + '.previous.log'))
                outputs[stream] = logs.enter_context(path.open('ab', buffering=0))
        return subprocess.Popen(args, cwd=str(Path(config['env_file']).parent), env=environment,
            stdin=subprocess.DEVNULL, **outputs,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def ensure(config, observe=processes, spawn=launch, probe=None, sleep=time.sleep,
           now=time.monotonic, readiness_timeout=SERVER_READY_TIMEOUT):
    deadline = now() + readiness_timeout
    probe = ready if probe is None else probe
    rows = observe()
    def matching(role):
        named = [p for p in rows if p['Name'].casefold() == 'webcodex-' + role + '.exe']
        if any(not p.get('ExecutablePath') for p in named):
            raise RuntimeError('backend_process_identity_unknown')
        owned = [p for p in named if normalized(p['ExecutablePath']) == normalized(config[role])]
        if role == 'runner':
            def original_config(row):
                try:
                    argv = command_argv(row.get('CommandLine'))
                    configs = []
                    for index, arg in enumerate(argv):
                        if arg == '--config':
                            if index + 1 >= len(argv) or not argv[index + 1] or argv[index + 1].startswith('--'):
                                raise ValueError()
                            configs.append(argv[index + 1])
                        elif arg.startswith('--config='):
                            if not arg[len('--config='):]:
                                raise ValueError()
                            configs.append(arg[len('--config='):])
                    if len(configs) > 1:
                        raise ValueError()
                    return bool(configs) and normalized(configs[0]) == normalized(config['runner_config'])
                except (OSError, ValueError, RuntimeError, TypeError):
                    raise RuntimeError('backend_process_identity_unknown') from None
            owned = [p for p in owned if original_config(p)]
        if len(owned) > 1:
            raise RuntimeError('backend_multiple_owners:' + role)
        return owned
    servers, runners = matching('server'), matching('runner')
    started = []

    def remaining():
        seconds = deadline - now()
        if seconds <= 0:
            if started:
                raise BackendStartupError('backend_server_not_ready', started)
            raise RuntimeError('backend_server_not_ready')
        return seconds

    def probe_ready():
        seconds = remaining()
        result = probe(config, timeout=min(5, seconds)) if probe is ready else probe(config)
        remaining()
        return result

    if not servers:
        if probe_ready():
            raise RuntimeError('backend_endpoint_has_unverified_owner')
        remaining()
        child = spawn([config['server']], config, 'server')
        started.append({'role': 'server', 'pid': child.pid})
    try:
        for attempt in range(30):
            if probe_ready():
                break
            sleep(min(.3, remaining()))
        else:
            if started:
                raise BackendStartupError('backend_server_not_ready', started)
            raise RuntimeError('backend_server_not_ready')
    except subprocess.TimeoutExpired as error:
        error.started = list(started)
        error.completion_unknown = True
        raise
    if not runners:
        try:
            child = spawn([config['runner'], '--config', config['runner_config']], config, 'runner')
            started.append({'role': 'runner', 'pid': child.pid})
            sleep(.5)
            if child.poll() is not None:
                raise BackendStartupError('backend_runner_exited', started)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            error.started = list(started)
            error.completion_unknown = bool(started)
            raise
    return {'state': 'ready', 'started': started, 'desktopLaunched': False,
            'reusedServer': bool(servers), 'reusedRunner': bool(runners)}


def prepare(root):
    folder = Path(root) / '.local/web-host'
    manifest = folder / 'backend-launch.json'
    folder.mkdir(parents=True, exist_ok=True)
    state = folder / 'backend-start.json'
    atomic_json(state, {'state': 'preparing', 'stage': 'backend'})
    try:
        if not manifest.is_file():
            raise RuntimeError('backend_launch_manifest_missing')
        with FileLease(folder / 'backend-launch.lock'):
            config = read_config(manifest)
            config['diagnostic_home'] = str(folder / 'backend-logs')
            result = ensure(config)
            atomic_json(state, result)
            return result
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        atomic_json(state, {'state': 'needs_attention', 'stage': 'backend',
            'reason': failure_code(error), 'started': getattr(error, 'started', []),
            'process_observation_attempts': getattr(error, 'process_observation_attempts', None),
            'completion_unknown': isinstance(error, subprocess.TimeoutExpired)
                or getattr(error, 'completion_unknown', False)})
        raise
