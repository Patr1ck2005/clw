"""Pinned WebCodex read-only HTTP adapter. Never exposes credentials or upstream errors."""
from __future__ import annotations
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import time
import tomllib
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

MAX_BODY = 2 * 1024 * 1024
READ_PATHS = {
    'status': '/api/runtime/status',
    'projects': '/api/runtime-console/projects',
    'sessions': '/api/runtime-console/workflow-sessions',
    'detail': '/api/runtime-console/workflow-session',
    'jobs': '/api/jobs/list',
}
# Both reviewed builds use the same list_jobs wire. The liveness update changes
# five transport/diagnostic files, retaining that contract. Observe the exact
# clean identity first; never select an alternate wire after a 404.
NATIVE_JOB_READ_COMMITS = {
    '37098d4624f0', '37098d4624f0000bfab54ad102ecb0df619d7dc6',
    '9ae45a2a0ad7', '9ae45a2a0ad7e0de170d35075cc7ff12c4b64d98',
}

SAFE_MESSAGES = {
    'not_configured': '尚未配置本机只读连接。运行 CONNECT_WORKBENCH.cmd；不要把凭据发到聊天。',
    'auth_required': '运行凭据已被拒绝。已清除本连接缓存；在本机更换凭据并重启工作台。',
    'access_denied': '当前项目访问已被拒绝；已清除该视图，不扩大权限。',
    'not_found': 'Project 或 Session 不再可见；已清除该视图。',
    'rate_limited': '后端要求降低读取频率；等待后再查询。',
    'upstream_timeout': '后端响应超时，最近成功观测已标为过期。',
    'upstream_unreachable': '后端暂不可达，最近成功观测已标为过期。',
    'upstream_invalid': '后端响应不符合固定版本合同，未采用新数据。',
    'incompatible_version': '后端不是已验收的 0.4.1；没有猜测兼容或更改后端。',
    'redirect_rejected': '后端返回重定向；未向其他地址转发凭据。',
    'busy': '该视图正在查询，请稍后查看。',
    'invalid_request': '视图选择参数无效。',
}

class ObservationError(Exception):
    def __init__(self, code: str, retry_after: float = 0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(SAFE_MESSAGES.get(code, '只读观察失败。'))

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ObservationError('redirect_rejected')

def validate_origin(value: str) -> str:
    if not isinstance(value, str) or len(value) > 200 or any(ord(c) < 33 for c in value):
        raise ValueError('Invalid loopback origin')
    u = urlsplit(value)
    if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
        raise ValueError('Use an explicit http://127.0.0.1:PORT origin')
    return f'http://127.0.0.1:{u.port}'

def validate_token(value: str) -> str:
    if not isinstance(value, str) or len(value) < 20 or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError('Invalid runtime credential')
    if not value.startswith(('wck_', 'wc_pat_', 'wc_oat_')):
        raise ValueError('Use a runtime shared key/PAT/OAuth credential, not an OpenAI or Runner/admin key')
    return value

def _runner_values(path: Path):
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError('Invalid explicitly selected Runner config')
    try:
        raw = tomllib.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError, UnicodeError):
        raise ValueError('Invalid Runner configuration syntax') from None
    validate_origin(raw.get('server_url'))
    return raw


def runner_profile_kind(path: Path) -> str:
    """Inspect only the chosen Runner file, never read a sibling credential implicitly."""
    raw = _runner_values(path)
    token = raw.get('token')
    if isinstance(token, str) and token.startswith('wc_agent_'):
        return 'managed'
    validate_token(token)
    return 'runtime_credential'


def runner_configuration(path: Path, user_token_file: Path | None = None):
    """Read only explicit references. A managed Runner token is NEVER sent to runtime APIs.
    Its separate user PAT needs a second explicit reference/confirmation in the local linker.
    The official v0.4.1 login layout places webcodex-user-token beside runner.toml.
    """
    path = path.resolve()
    raw = _runner_values(path)
    runner_token = raw.get('token')
    managed = isinstance(runner_token, str) and runner_token.startswith('wc_agent_')
    if managed:
        if user_token_file is None:
            raise ValueError('Managed Runner profile requires an explicitly selected user token file')
        ref = Path(user_token_file)
        if not ref.is_absolute():
            raise ValueError('User token reference must be absolute')
        ref = ref.resolve()
        if ref.parent != path.parent or ref.name != 'webcodex-user-token':
            raise ValueError('Select the user token from this exact login profile, not another account')
        if not ref.is_file() or ref.stat().st_size > 4096:
            raise ValueError('Selected user token file is unavailable')
        token = validate_token(ref.read_text(encoding='utf-8-sig').strip())
        if not token.startswith('wc_pat_'):
            raise ValueError('Managed login needs its user PAT, never the Runner transport token')
    else:
        if user_token_file is not None:
            raise ValueError('Do not mix a shared runtime key with a managed user token')
        token = validate_token(runner_token)
    return Transport(raw.get('server_url'), token, raw.get('client_id', ''))

def configuration(path: Path):
    """Read only a caller-selected product config; no discovery of Desktop secrets."""
    if not path.exists():
        return None
    if path.stat().st_size > 16384:
        raise ValueError('Oversized observer config')
    raw = json.loads(path.read_text(encoding='utf-8-sig'))
    allowed = {'schema_version', 'server_url', 'client_id', 'token_env', 'token_file', 'runner_config', 'user_token_file'}
    if not isinstance(raw, dict) or set(raw) - allowed or raw.get('schema_version') != 1:
        raise ValueError('Unknown observer config')
    if raw.get('runner_config'):
        if set(raw) not in ({'schema_version','runner_config'}, {'schema_version','runner_config','user_token_file'}):
            raise ValueError('Runner config reference cannot be mixed with credentials')
        ref = Path(raw['runner_config'])
        if not ref.is_absolute():raise ValueError('Runner config reference must be exact and absolute')
        user_ref = Path(raw['user_token_file']) if 'user_token_file' in raw else None
        return runner_configuration(ref, user_ref)
    if 'user_token_file' in raw:
        raise ValueError('Managed user token requires an explicit Runner profile reference')
    origin = validate_origin(raw.get('server_url'))
    if bool(raw.get('token_env')) == bool(raw.get('token_file')):
        raise ValueError('Specify exactly one explicit credential reference')
    if raw.get('token_env'):
        name = raw['token_env']
        if not re.fullmatch(r'CLW_[A-Z0-9_]{1,80}', name):
            raise ValueError('Use a dedicated CLW_ environment variable')
        token = os.environ.get(name, '').strip()
    else:
        ref = Path(raw['token_file'])
        if not ref.is_absolute():
            ref = path.parent / ref
        if ref.stat().st_size > 4096:
            raise ValueError('Invalid credential file')
        token = ref.read_text(encoding='utf-8-sig').strip()
    client = raw.get('client_id', '')
    if client and (not isinstance(client, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', client)):
        raise ValueError('Invalid Runner ID')
    return Transport(origin, validate_token(token), client)

class Transport:
    def __init__(self, origin: str, token: str, client_id: str = '', *, timeout=6.0, sleep=time.sleep):
        self.origin = validate_origin(origin)
        self._token = validate_token(token)
        if not isinstance(client_id,str) or (client_id and not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',client_id)):
            raise ValueError('Invalid Runner ID')
        self.client_id = client_id
        # Credential-bound local namespace. Not an OpenAI account identity or usable credential.
        self.namespace = 'wc-live-' + hashlib.sha256((self.origin + '\0' + self._token).encode()).hexdigest()[:24]
        self.timeout, self.sleep = timeout, sleep
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.requests = 0
        self.retries = 0
        self._native_job_read = False

    def post(self, operation: str, payload: dict, deadline: float):
        if operation not in READ_PATHS:
            raise ObservationError('invalid_request')
        path = READ_PATHS[operation]
        if operation == 'jobs' and self._native_job_read:
            path = '/api/tools/call'
            payload = {'tool': 'list_jobs', 'params': payload}
        encoded = json.dumps(payload, separators=(',', ':')).encode()
        if len(encoded) > 4096:
            raise ObservationError('invalid_request')
        for attempt in range(3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ObservationError('upstream_timeout')
            req = Request(self.origin + path, data=encoded, method='POST', headers={
                'Authorization': 'Bearer ' + self._token,
                'Content-Type': 'application/json', 'Accept': 'application/json',
            })
            error = None
            try:
                self.requests += 1
                with self.opener.open(req, timeout=min(self.timeout, remaining)) as response:
                    if response.headers.get('Content-Encoding', 'identity') != 'identity':
                        raise ObservationError('upstream_invalid')
                    if response.headers.get_content_type() != 'application/json':
                        raise ObservationError('upstream_invalid')
                    chunks=[];size=0
                    while True:
                        if time.monotonic()>=deadline:
                            raise ObservationError('upstream_timeout')
                        chunk=response.read1(min(65536,MAX_BODY+1-size))
                        if not chunk:break
                        size+=len(chunk)
                        if size>MAX_BODY:raise ObservationError('upstream_invalid')
                        chunks.append(chunk)
                    parsed = json.loads(b''.join(chunks))
                    if not isinstance(parsed, dict):
                        raise ObservationError('upstream_invalid')
                    if operation in ('status', 'jobs'):
                        if parsed.get('success') is not True or not isinstance(parsed.get('output'), dict):
                            raise ObservationError('upstream_invalid')
                        if operation == 'status':
                            status = parsed['output']
                            server = status.get('server')
                            build = status.get('build') or (server.get('build') if isinstance(server, dict) else None)
                            self._native_job_read = (status.get('service') == 'webcodex' and status.get('version') == '0.4.1'
                                                     and isinstance(build, dict) and build.get('git_dirty') is False
                                                     and build.get('git_commit') in NATIVE_JOB_READ_COMMITS)
                        return parsed['output']
                    return parsed
            except HTTPError as exc:
                # Error bodies are not consumed, logged or left holding a socket.
                exc.close()
                code = {401:'auth_required', 403:'access_denied', 404:'not_found', 429:'rate_limited'}.get(exc.code)
                if code:
                    retry = 60.0
                    if code == 'rate_limited':
                        try: retry = max(5.0, min(300.0, float(exc.headers.get('Retry-After', '60'))))
                        except (TypeError, ValueError): pass
                    raise ObservationError(code, retry) from None
                error = ObservationError('upstream_unreachable' if exc.code in (502,503,504) else 'upstream_invalid')
                if exc.code not in (502,503,504):
                    raise error from None
            except (TimeoutError, socket.timeout):
                error = ObservationError('upstream_timeout')
            except URLError as exc:
                error = ObservationError('upstream_timeout' if isinstance(exc.reason, (TimeoutError,socket.timeout)) else 'upstream_unreachable')
            except (ConnectionError, http.client.HTTPException, OSError):
                error = ObservationError('upstream_unreachable')
            except (ValueError, UnicodeError, RecursionError):
                raise ObservationError('upstream_invalid') from None
            if attempt == 2:
                raise error
            self.retries += 1
            self.sleep(min(0.25 * 2**attempt, max(0, deadline-time.monotonic())))
        raise ObservationError('upstream_invalid')
