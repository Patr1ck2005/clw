"""No-model native HTTP protocol fixture. Never reads real credentials or launches Codex."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,threading
P='agent:test:project';ROOT_PATH='D:/sandbox/project'
class FakeNative:
    def __init__(self):
        self.enabled=True;self.namespace='fixture-namespace';self.binding='fixture-binding';self.provider=True;self.calls=[];self.runs={};self.mode='running';self.execution='started';self.lose_once=False;self.reject=False;self.wrong_identity=False;self.events=[];self.lock=threading.Lock()
    def discover(self,project):
        return {'available':self.provider,'enabled':self.enabled,'providers':[{'id':'codex','name':'No-model test Codex','binding':self.binding}] if self.provider else [],'connection':self.namespace,'observed_at':'2026-09-21T00:00:00Z','reason':'isolated protocol fixture'}
    def call(self,tool,params):
        with self.lock:
            self.calls.append((tool,params.copy()))
            if tool=='coding_agent_start':
                if self.reject:return {'success':False,'output':{'run_id':'wc_agent_run_rejected','execution_state':'not_started','error_kind':'unsupported_config'}}
                key=params['idempotency_key'];self.runs.setdefault(key,{'run_id':'wc_agent_run_'+str(len(self.runs)+1),'project':params['project'],'provider_id':params['provider_id']});r=self.runs[key].copy()
                if self.lose_once:self.lose_once=False;raise OSError('Controlled lost response')
            else:
                r=next((r.copy() for r in self.runs.values() if r['run_id']==params['run_id']),None)
                if not r:return {'success':False,'output':{'run_id':params['run_id'],'execution_state':'outcome_unknown','error_kind':'lost'}}
            r.update(state=self.mode,execution_state=self.execution,terminal={'stop_reason':None if self.execution=='not_started' else ('cancelled' if self.mode=='cancelled' else 'end_turn'),'completed_at':1789950000} if self.mode in {'completed','cancelled','failed'} else None)
            if tool=='coding_agent_observe':r.update(events=self.events,has_more=False,history_lost=False,observation_token='opaque-original-token')
            if self.wrong_identity:r['project']='agent:other:project'
            return {'success':True,'output':r}
class NativeHTTP:
    def __init__(self):
        self.fake=FakeNative();self.requests=[];self.reject_auth=False;self.redirect=False;self.bad_body=False;self.omit_provider_details=False
        outer=self
        class H(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_POST(self):
                raw=json.loads(self.rfile.read(int(self.headers['Content-Length'])));outer.requests.append((self.path,raw))
                if outer.redirect:self.send_response(302);self.send_header('Location','http://127.0.0.1:9/never');self.end_headers();return
                if outer.reject_auth:self.send_response(403);self.end_headers();return
                if self.path=='/api/runtime/status':data={'success':True,'output':{'version':'0.4.1'}}
                elif self.path=='/api/tools/call' and raw['tool']=='list_runners':
                    data={'success':True,'output':{'agents':[{'client_id':'test','connected':True,'agent_instance_id':'runner-1','capabilities':{'coding_agent_runs':outer.fake.provider},'coding_agent_providers':[{'provider_id':'codex','provider_instance_id':'instance-1','name':'fake'}]}]}}
                elif self.path=='/api/tools/call':data=outer.fake.call(raw['tool'],raw['params'])
                else:self.send_response(404);self.end_headers();return
                if outer.omit_provider_details and self.path=='/api/tools/call' and raw['tool']=='list_runners':
                    data['output']['agents'][0].pop('coding_agent_providers',None)
                text=b'not-json' if outer.bad_body else json.dumps(data).encode();self.send_response(200 if data.get('success') else 400);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(text)));self.end_headers();self.wfile.write(text)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),H);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join()
