"""Synthetic fixed-contract HTTP fixture. Never substitutes for a real user connection."""
from __future__ import annotations
import copy
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import threading
import time

TOKEN='wck_synthetic_test_only_1234567890abcdef'
P1='agent:test-runner:alpha'
P2='agent:test-runner:beta'
S1='wc_sess_alpha'
S2='wc_sess_beta'
OLD='wc_sess_old_exact'

def activity(n=0):
 return {'kind':'Tool','tool':'run_process','state':'succeeded','execution_state':'running',
  'job_handoff':True,'started_at':1789911000+n,'finished_at':1789911001+n,
  'duration_ms':1000,'job_id':'test-job','summary':'后台工作已接受；没有最终退出码','paths':[]}

def session(sid=S1):
 return {'session_id':sid,'title':'合成联调任务 '+sid,'lifecycle':'active','mode':'coding',
  'created_at':1789911000,'updated_at':1789911001,'running_call':False,'running_jobs':1,
  'running_jobs_complete':True,'overview':{}}

class Fixture:
 def __init__(self):
  self.requests=[];self.overrides={};self.delay=0;self.change=0;self.detail_id=None;self.expanded=False;self.gate=None
  owner=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    if int(self.headers.get('Content-Length',0))>10000:self.send_error(413);return
    payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
    owner.requests.append({'path':self.path,'body':payload,'cookie':self.headers.get('Cookie'), 'authorization_ok':self.headers.get('Authorization')=='Bearer '+TOKEN})
    if owner.gate:owner.gate.wait(2)
    if owner.delay:time.sleep(owner.delay)
    if self.headers.get('Authorization')!='Bearer '+TOKEN:
     code,data,headers=401,{'error':'unauthorized'},{}
    elif self.path in owner.overrides:
     override=owner.overrides[self.path]
     if callable(override):code,data,headers=override(payload)
     else:code,data,headers=override
    else:
     code,data,headers=200,owner.body(self.path,payload),{}
    raw=data if isinstance(data,bytes) else json.dumps(data).encode()
    try:
     self.send_response(code);self.send_header('Content-Type',headers.pop('Content-Type','application/json'))
     for k,v in headers.items():self.send_header(k,v)
     self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    except (BrokenPipeError,ConnectionResetError):pass
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
  self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
 def body(self,path,payload):
  if path=='/api/runtime/status':return {'success':True,'output':{'service':'webcodex','version':'0.4.1','focus':{'status':'online','job_concurrency':{'limit':4}}}}
  if path=='/api/runtime-console/projects':
   p=[{'id':P1,'name':'Alpha','path':'D:/sandbox/alpha','client_id':'test-runner','connected':True},{'id':P2,'name':'Beta','path':'D:/sandbox/beta','client_id':'test-runner','connected':True}]
   q=payload.get('query','').lower();p=[v for v in p if not q or q in v['name'].lower()]
   return {'projects':p,'total':len(p),'truncated':False}
  if path=='/api/runtime-console/workflow-sessions':
   sid=S1 if payload['project']==P1 else S2
   return {'sessions':[session(sid)],'total':51 if self.expanded else 1,'returned':1,'truncated':self.expanded}
  if path=='/api/runtime-console/workflow-session':
   s=session(self.detail_id or payload['session_id']);s.update(activity=[activity(self.change)],activity_total=1,activity_returned=1,activity_truncated=False);return s
  if path=='/api/jobs/list':return {'success':True,'output':{'jobs':[{'job_id':'test-job','project':payload['project'],'session_id':S1 if payload['project']==P1 else S2,'status':'running','exit_code':None,'elapsed_secs':self.change}], 'count':1,'matched_count':1,'truncated':False}}
  return {'error':'unknown test endpoint'}
 def close(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=3)
