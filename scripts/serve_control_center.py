"""Loopback workbench. Static snapshots plus a fixed-path, read-only WebCodex adapter."""
from __future__ import annotations
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
import webbrowser
import json
import sys
import getpass
import warnings
import time
sys.path.insert(0,str(Path(__file__).resolve().parent))
from live_transport import Transport, configuration, runner_configuration, ObservationError
from live_observer import Observer
from link_workbench import select_and_link
from task_store import TaskStore
from task_http import TaskHTTP
from usage_store import UsageStore
from coding_agent_bridge import NativeAgentBridge
from specialist_service import Specialists
from specialist_http import SpecialistHTTP
from ingress_health import IngressSources, IngressHealth
from account_store import AccountStore
from account_http import AccountHTTP
from asset_store import AssetStore
from asset_http import AssetHTTP
from product_runtime import ProductError, RuntimeIdentity, StateLease
from communication_bridge import CommunicationBridge
from task_routing import RoutingEngine

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'apps/control-center'
FILES={'/':('index.html','text/html;charset=utf-8'),'/index.html':('index.html','text/html;charset=utf-8'),'/app.mjs':('app.mjs','text/javascript;charset=utf-8'),'/model.mjs':('model.mjs','text/javascript;charset=utf-8'),'/annotations.mjs':('annotations.mjs','text/javascript;charset=utf-8'),'/live.mjs':('live.mjs','text/javascript;charset=utf-8'),'/style.css':('style.css','text/css;charset=utf-8'),'/live.css':('live.css','text/css;charset=utf-8'),'/data/observed.json':('data/observed.json','application/json;charset=utf-8')}
FILES.update({
    '/tasks.html':('tasks.html','text/html;charset=utf-8'),
    '/tasks.css':('tasks.css','text/css;charset=utf-8'),
    '/task-ui.mjs':('task-ui.mjs','text/javascript;charset=utf-8'),
    '/task-client.mjs':('task-client.mjs','text/javascript;charset=utf-8'),
})
FILES.update({name:(name[1:],mime) for name,mime in (
    ('/specialists.html','text/html;charset=utf-8'),('/specialists.mjs','text/javascript;charset=utf-8'),
    ('/specialists.css','text/css;charset=utf-8'),('/journal-client.mjs','text/javascript;charset=utf-8'))})
FILES.update({name:(name[1:],mime) for name,mime in (
    ('/accounts.html','text/html;charset=utf-8'),('/accounts.mjs','text/javascript;charset=utf-8'),
    ('/accounts.css','text/css;charset=utf-8'),('/account-view.mjs','text/javascript;charset=utf-8'))})
FILES.update({name:(name[1:],mime) for name,mime in (
    ('/assets.html','text/html;charset=utf-8'),('/assets.mjs','text/javascript;charset=utf-8'),
    ('/assets.css','text/css;charset=utf-8'),('/asset-client.mjs','text/javascript;charset=utf-8'))})
FILES.update({'/product-status.mjs':('product-status.mjs','text/javascript;charset=utf-8'), '/product-status.css':('product-status.css','text/css;charset=utf-8')})
FILES['/task-resources.mjs']=('task-resources.mjs','text/javascript;charset=utf-8')
FILES['/task-goals.mjs']=('task-goals.mjs','text/javascript;charset=utf-8')
FILES['/task-routing.mjs']=('task-routing.mjs','text/javascript;charset=utf-8')
FILES.update({'/harness.html':('harness.html','text/html;charset=utf-8'),'/harness.css':('harness.css','text/css;charset=utf-8'),'/harness-ui.mjs':('harness-ui.mjs','text/javascript;charset=utf-8'),'/harness-model.mjs':('harness-model.mjs','text/javascript;charset=utf-8')})
FILES['/harness-team-ui.mjs']=('harness-team-ui.mjs','text/javascript;charset=utf-8')
CSP="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

class Handler(BaseHTTPRequestHandler):
    def send_response(self, code, message=None):
        self._response_code=code
        return super().send_response(code,message)
    def finish(self):
        # After rejecting an oversized upload, closing with unread inbound data can
        # reset TCP on Windows and hide the 413 response. Drain a strictly bounded
        # amount for a bounded time; never parse, store or accept the rejected body.
        try:
            self.wfile.flush()
            if getattr(self,'_response_code',None)==413:
                length=self.headers.get('Content-Length','')
                remaining=min(int(length),4*1024*1024) if len(length)<=12 and length.isdecimal() else 0
                deadline=time.monotonic()+.35
                while remaining and time.monotonic()<deadline:
                    self.connection.settimeout(max(.01,deadline-time.monotonic()))
                    chunk=self.rfile.read1(min(65536,remaining))
                    if not chunk:break
                    remaining-=len(chunk)
        except (OSError,ValueError):pass
        finally:super().finish()
    def log_message(self,*args):
        pass # no query strings or arbitrary input in logs
    def end_headers(self):
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',CSP)
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Cross-Origin-Resource-Policy','same-origin')
        super().end_headers()
    def do_GET(self):
        if getattr(self.server,'harness_api',None) and self.server.harness_api.handle(self): return
        if getattr(self.server,'asset_api',None) and self.server.asset_api.handle(self): return
        if getattr(self.server,'account_api',None) and self.server.account_api.handle(self): return
        if getattr(self.server,'specialist_api',None) and self.server.specialist_api.handle(self): return
        if getattr(self.server,'task_api',None) and self.server.task_api.handle(self): return
        port=self.server.server_address[1]
        host=self.headers.get('Host','')
        if host not in {f'127.0.0.1:{port}',f'localhost:{port}'}:
            self.send_error(403,'Host not allowed');return
        origin=self.headers.get('Origin')
        if origin and origin not in {f'http://127.0.0.1:{port}',f'http://localhost:{port}'}:
            self.send_error(403,'Origin not allowed');return
        if self.headers.get('Sec-Fetch-Site')=='cross-site':
            self.send_error(403,'Cross-site request not allowed');return
        if len(self.path)>4096:
            self.send_error(414);return
        parsed=urlsplit(self.path);path=parsed.path
        if path == '/api/product/info':
            if parsed.query:
                self.send_error(400); return
            info = self.server.product_identity.info()
            info['capabilities'] = {name: getattr(self.server, attribute, None) is not None for name, attribute in (('tasks','task_api'),('accounts','account_api'),('specialists','specialist_api'),('assets','asset_api'))}
            TaskHTTP.send(self, 200, {'success': True, **info}); return
        if path in ('/api/live/info','/api/live/state'):
            try:
                query=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=bool(parsed.query))
                if set(query)-{'project','session','query','after'} or any(len(v)!=1 for v in query.values()):
                    raise ObservationError('invalid_request')
                if path.endswith('/info'):
                    if query:raise ObservationError('invalid_request')
                    value=self.server.observer.info()
                else:value=self.server.observer.state(**{k:v[0] for k,v in query.items()})
                data=json.dumps(value,ensure_ascii=False).encode('utf-8')
                self.send_response(200);self.send_header('Content-Type','application/json;charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            except (ObservationError,ValueError) as exc:
                code=exc.code if isinstance(exc,ObservationError) else 'invalid_request'
                data=json.dumps({'error_code':code}).encode();self.send_response(400);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            except ConnectionError:pass # includes normal Windows browser-abort/reset
            return
        if path not in FILES:
            self.send_error(404);return
        name,mime=FILES[path]
        data=self.server.static_assets.get('apps/control-center/'+name)
        if data is None:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_OPTIONS(self):
        if self.path in ('/api/harness/recovery-wire','/api/harness/control-wire') and getattr(self.server,'harness_api',None):
            self.server.harness_api.handle(self);return
        self.send_error(405)
    def do_POST(self):
        if getattr(self.server,'harness_api',None) and self.server.harness_api.handle(self): return
        if getattr(self.server,'asset_api',None) and self.server.asset_api.handle(self): return
        if getattr(self.server,'account_api',None) and self.server.account_api.handle(self): return
        if getattr(self.server,'specialist_api',None) and self.server.specialist_api.handle(self): return
        if getattr(self.server,'task_api',None) and self.server.task_api.handle(self): return
        self.send_error(405,'Runtime observer is read-only')
    do_PUT=do_DELETE=do_PATCH=do_POST

class Server(ThreadingHTTPServer):
    allow_reuse_address=False
    daemon_threads=False  # Keep data ownership until in-flight handlers have actually finished.
    def service_actions(self):
        # Deterministic metadata scheduling continues without an open browser.
        # Observation/check times never update any role's model-progress record.
        if time.monotonic()<getattr(self,'_resource_check_after',0):return
        self._resource_check_after=time.monotonic()+2
        api=getattr(self,'task_api',None)
        if api is None:return
        try:
            changed=api.store.coordinate_resources()
            self.resource_coordinator_status={'status':'observed','changed_tasks':changed,'checked_at':time.time(),'model_called':False}
        except Exception:
            self.resource_coordinator_status={'status':'unavailable','checked_at':time.time(),'occupancy_released':False,'model_called':False}
        finally:self._resource_check_after=time.monotonic()+2

    def server_close(self):
        engine=getattr(self,'routing_engine',None)
        if engine is not None:engine.stop()
        super().server_close()

    def get_request(self):
        sock,address=super().get_request();sock.settimeout(10);return sock,address

def create_server(port=0,observer=None,task_store=None,specialists=None,usage_store=None,account_store=None,asset_store=None,product_identity=None):
    if product_identity is None:
        from web_workspace_runtime import runtime_identity
        identity=runtime_identity(ROOT,channel='test')
    else:identity=product_identity
    server=Server(('127.0.0.1',port),Handler)
    server.product_identity=identity
    server.static_assets=identity.files
    server.observer=observer if observer is not None else Observer(None)
    server.asset_api=AssetHTTP(asset_store) if asset_store is not None else None
    server.account_api=AccountHTTP(account_store) if account_store is not None else None
    server.task_api=TaskHTTP(task_store) if task_store is not None else None
    server.specialist_api=SpecialistHTTP(specialists,usage_store) if specialists is not None and usage_store is not None else None
    if task_store is not None and task_store.communication is not None:
        server.routing_engine=RoutingEngine(task_store,task_store.communication,f'http://127.0.0.1:{server.server_address[1]}')
        server.routing_engine.start()
    return server
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--port',type=int,default=18940);p.add_argument('--open',action='store_true')
    p.add_argument('--channel',choices=['development','candidate','stable'],default='development')
    p.add_argument('--state-dir',type=Path,help='Application data only; release launcher separates stable/candidate/development directories')
    p.add_argument('--expected-state-id',help='Selected data identity, verified by the child under its state lease')
    p.add_argument('--config',type=Path)
    p.add_argument('--tasks-db',type=Path,help='Product-owned task database within state-dir')
    p.add_argument('--connect',action='store_true',help='Ask for runtime credential locally; keep it only in process memory')
    p.add_argument('--choose-runner-config',action='store_true',help='Human selects one Desktop Runner config; only a path reference is saved')
    p.add_argument('--usage-db',type=Path)
    p.add_argument('--enable-codex-specialists',action='store_true',help='Interactive local opt-in; configured native providers only, never independent API dispatch')
    p.add_argument('--enable-workflow-routing',action='store_true',help='Local interactive opt-in for exact pinned native task notification routes; no direct model API')
    p.add_argument('--codex-provider-id',action='append',default=[],help='Explicit local logical Provider ID; not verified advertising; native pre-prompt validation remains mandatory')
    p.add_argument('--ingress-sources',type=Path,help='Explicit non-secret health URL file references, never Tunnel credentials')
    p.add_argument('--accounts-db',type=Path)
    p.add_argument('--assets-db',type=Path)
    a=p.parse_args()
    if a.channel in ('stable','candidate') and a.state_dir is None:p.error('Fixed release needs an explicit state directory from the launcher')
    if a.channel == 'stable' and a.expected_state_id is None:p.error('Stable launch requires expected-state-id from the release launcher')
    state=(a.state_dir or ROOT/'.local/development-control-center').resolve()
    a.config=a.config or state/'connection.json';a.ingress_sources=a.ingress_sources or state/'ingresses.json'
    for field,name in (('tasks_db','tasks.sqlite3'),('accounts_db','accounts.sqlite3'),('usage_db','usage.sqlite3'),('assets_db','assets.sqlite3')):
        value=(getattr(a,field) or state/name).resolve()
        if value.parent!=state:p.error('Database files must belong to the selected state directory')
        setattr(a,field,value)
    from web_workspace_runtime import runtime_identity
    identity=runtime_identity(ROOT,a.channel)
    # Optional execution is never enabled by an existing read-only connection reference.
    if not 0<=a.port<=65535:p.error('invalid port')
    enabled=False
    if a.enable_codex_specialists:
        if not sys.stdin.isatty():raise SystemExit('Specialist execution requires local interactive confirmation; nothing dispatched.')
        print('This enables explicit native provider actions. Provider account, billing and sandbox must be checked locally; no budget enforcement or automatic fallback.')
        enabled=input('Type ENABLE NATIVE CODEX after checking provider account, sandbox and allowed models: ').strip()=='ENABLE NATIVE CODEX'
        if not enabled:raise SystemExit('Execution opt-in cancelled; no provider was started.')
    routing_enabled=False
    if a.enable_workflow_routing:
        if not sys.stdin.isatty():raise SystemExit('Workflow routing requires explicit local interactive confirmation; nothing dispatched.')
        print('This enables native task notifications for explicitly authorized tasks. A mounted Host may request follow-up turns. Verify account, scope and native version locally; no account/model fallback.')
        routing_enabled=input('Type ENABLE WORKFLOW ROUTING after checking the native connection and permitted tasks: ').strip()=='ENABLE WORKFLOW ROUTING'
        if not routing_enabled:raise SystemExit('Workflow routing opt-in cancelled; nothing dispatched.')
    # Bind and verify the selected identity under the kernel lease before loading
    # connection references, linking credentials, or initializing any product DB.
    try:server=create_server(a.port,product_identity=identity)
    except OSError:raise SystemExit('Control Center port unavailable. No existing service stopped; close only its old terminal.')
    try:
        with StateLease(state, expected_identity=a.expected_state_id) as owner:
            identity.base['state_id']=owner.identity
            transport=None
            if a.choose_runner_config:
                if a.connect:p.error('Choose one connection method')
                linked = select_and_link(a.config)
                if linked is None:raise SystemExit('Connection not changed; selection cancelled or verification failed.')
                transport, receipt = linked
                print('Runtime read-only connection verified. Credential contents are not displayed.')
                print('Connection reference created:', receipt['created'])
            elif a.connect:
                print('Enter local WebCodex Server origin from Desktop diagnostics. No OpenAI/Tunnel API key.')
                origin=input('Server origin (http://127.0.0.1:PORT): ').strip()
                runner=input('Runner ID (Enter = visible fleet): ').strip()
                if not sys.stdin.isatty():raise SystemExit('Interactive terminal required for hidden credential input.')
                with warnings.catch_warnings():
                    warnings.simplefilter('error',getpass.GetPassWarning)
                    try:token=getpass.getpass('WebCodex runtime credential (hidden, memory only): ')
                    except getpass.GetPassWarning:raise SystemExit('Hidden input unavailable; nothing was accepted.')
                try:transport=Transport(origin,token,runner)
                except ValueError:raise SystemExit('Invalid local origin or runtime credential type; nothing was changed.')
                del token
            else:
                try:transport=configuration(a.config)
                except (OSError,ValueError,TypeError):raise SystemExit('Invalid product connection configuration. No secret values were printed; stable WebCodex unchanged.')
            if enabled and transport is None:raise SystemExit('Link the product connection locally before enabling native specialists.')
            observer=Observer(transport);server.observer=observer
            if routing_enabled and transport is None:raise SystemExit('Link an exact native connection before enabling workflow routing.')
            communication=CommunicationBridge(transport,enabled=routing_enabled)
            if routing_enabled:
                try:communication.check_runtime()
                except Exception:raise SystemExit('Pinned workflow communication is not available; no alternate backend was used.')
            tasks=TaskStore(a.tasks_db,observer,communication=communication)
            specialists=Specialists(tasks,NativeAgentBridge(transport,enabled=enabled,provider_ids=a.codex_provider_id))
            sources=IngressSources.load(a.ingress_sources)
            accounts=AccountStore(a.accounts_db,sources,observer,IngressHealth(sources),tasks)
            server.task_api=TaskHTTP(tasks)
            server.specialist_api=SpecialistHTTP(specialists,UsageStore(a.usage_db))
            server.account_api=AccountHTTP(accounts)
            server.asset_api=AssetHTTP(AssetStore(a.assets_db,tasks,observer))
            server.routing_engine=RoutingEngine(tasks,communication,f'http://127.0.0.1:{server.server_address[1]}')
            server.routing_engine.start()
            url=f'http://127.0.0.1:{server.server_address[1]}/'
            print('CLW Control Center:',url,flush=True)
            print('CLW_IDENTITY',json.dumps(identity.base),flush=True)
            print('Startup does not call models. Observer configured:',transport is not None,'Native execution enabled:',enabled,flush=True)
            print('Ctrl+C stops only this workbench, not WebCodex or its Jobs.',flush=True)
            if a.open:webbrowser.open(url+('?live=1' if transport else ''))
            try:server.serve_forever()
            except KeyboardInterrupt:pass
            finally:server.server_close()
    except ProductError as exc:raise SystemExit('Control Center state rejected: '+str(exc))
    finally:server.server_close()
if __name__=='__main__':main()
