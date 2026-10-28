"""End-to-end adapter check using fresh, isolated published 0.4.1 Server/Runner.
No stable config/database/key is read. Only the caller-specified binary directory
is reused read-only. Native tool calls create work exclusively in a test root.
"""
from __future__ import annotations
import argparse,hashlib,json,os,secrets,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import URLError
from live_transport import Transport
from live_observer import Observer
from serve_control_center import create_server
ROOT=Path(__file__).resolve().parents[1]

def main():
 sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--binary-dir',type=Path,required=True);args=parser.parse_args()
 binaries=args.binary_dir.resolve()
 for name in ('webcodex.exe','webcodex-runner.exe','webcodex-server.exe'):
  if not (binaries/name).is_file():raise SystemExit('Missing caller-selected published binary')
 stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
 base=ROOT/'.local/WB0022-native'/stamp;base.mkdir(parents=True)
 evidence=ROOT/'evidence/WB002-2/native'/stamp;evidence.mkdir(parents=True)
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();origin=f'http://127.0.0.1:{port}'
 env={k:v for k,v in os.environ.items() if not k.upper().startswith(('WEBCODEX_','CLW_'))};env['PYTHONUTF8']='1'
 key='wck_'+secrets.token_urlsafe(32)
 init=subprocess.run([str(binaries/'webcodex.exe'),'server','init','--listen',f'127.0.0.1:{port}','--data-dir',str(base/'data'),'--env-file',str(base/'server.env'),'--json'],env=env,cwd=base,capture_output=True,timeout=20)
 if init.returncode:raise SystemExit('Isolated server initialization failed; no raw output exposed')
 projects=base/'projects';projects.mkdir();registry=base/'project-registry';registry.mkdir()
 for ident in ('alpha','beta'):
  path=projects/ident;path.mkdir();(path/'AGENTS.md').write_text('Isolated CLW adapter validation only. No external projects.\n')
  (registry/(ident+'.toml')).write_text('id = '+json.dumps(ident)+'\nname = '+json.dumps('CLW-native-'+ident)+'\npath = '+json.dumps(path.as_posix())+'\nallow_patch = true\n')
 config='server_url = '+json.dumps(origin)+'\ntoken = '+json.dumps(key)+'\nclient_id = "clw-wb0022-native"\ndisplay_name = "Isolated WB002.2"\nowner = "clw-test"\nproject_registry_dir = '+json.dumps(registry.as_posix())+'\npoll_interval_ms = 500\n[policy]\nallowed_roots = ['+json.dumps(projects.as_posix())+']\nallow_cwd_anywhere = false\nallow_raw_shell = true\nmax_timeout_secs = 45\nmax_output_bytes = 16384\n'
 (base/'runner.toml').write_text(config,encoding='utf-8')
 handles=[];children=[];workbench=None;workbench_thread=None;pw=None;browser=None
 checks=[];receipts={};mcp_session=None;sequence=0
 def check(name,condition):
  checks.append({'name':name,'passed':bool(condition)})
  if not condition:raise AssertionError(name)
 def post(path,payload):
  headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
  if mcp_session:headers['Mcp-Session-Id']=mcp_session
  req=Request(origin+path,data=json.dumps(payload).encode(),method='POST',headers=headers)
  with urlopen(req,timeout=35) as response:
   data=response.read(2*1024*1024);session_header=response.headers.get('Mcp-Session-Id')
  if not data:return {},session_header
  try:return json.loads(data),session_header
  except ValueError:
   for line in data.decode().splitlines():
    if line.startswith('data: '):return json.loads(line[6:]),session_header
   raise AssertionError('No JSON RPC response')
 def call(tool,arguments):
  nonlocal sequence
  sequence+=1;rpc,_=post('/mcp',{'jsonrpc':'2.0','id':sequence,'method':'tools/call','params':{'name':tool,'arguments':arguments}})
  if rpc.get('error'):raise AssertionError('Native MCP rejected '+tool)
  result=rpc['result'];value=result.get('structuredContent')
  if value is None:
   for content in result.get('content',[]):
    if content.get('type')=='text':
     try:value=json.loads(content['text']);break
     except ValueError:pass
  if not isinstance(value,dict):raise AssertionError('Missing native structured result '+tool)
  if value.get('success') is False:
   (base/'last-tool-failure.json').write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
   raise AssertionError('Native tool failed '+tool+'; private test-only diagnostic retained')
  return value.get('output',value)
 report={'kind':'published native 0.4.1 isolated integration','user_stable_connection':False,'paid_model_calls':0,'checks':checks}
 try:
  for exe,argv in [('webcodex.exe',['server','run','--env-file',str(base/'server.env')]),('webcodex-runner.exe',['--config',str(base/'runner.toml'),'--stop-on-stdin-eof'])]:
   log=open(base/(exe+'.log'),'wb');handles.append(log);children.append(subprocess.Popen([str(binaries/exe),*argv],stdin=subprocess.PIPE,stdout=log,stderr=log,cwd=base,env=env))
   if exe=='webcodex.exe':time.sleep(.5)
  listing=None
  for _ in range(40):
   try:
    listing,_=post('/api/runtime-console/projects',{'limit':100})
    if len(listing.get('projects',[]))==2:break
   except (OSError,ValueError):pass
   time.sleep(.5)
  check('two isolated projects registered',listing is not None and len(listing.get('projects',[]))==2)
  sequence+=1;initialized,mcp_session=post('/mcp',{'jsonrpc':'2.0','id':sequence,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'clw-native-contract-test','version':'0.2'}}})
  check('native MCP initialized','result' in initialized)
  post('/mcp',{'jsonrpc':'2.0','method':'notifications/initialized'})
  project='agent:clw-wb0022-native:alpha'
  task=call('work_on_project',{'project':project,'instruction':'Isolated read-only adapter verification. Operate only this temporary test project.'});session_id=task.get('session_id')
  check('native workflow session created',isinstance(session_id,str) and session_id.startswith('wc_sess_'))
  revision=task.get('session_context_revision')
  read=call('read_files',{'project':project,'items':[{'path':'AGENTS.md','limit':20}],'recording_session_id':session_id,**({'ack_session_context_revision':revision} if revision is not None else {})})
  check('native source read succeeded',read.get('succeeded_count')==1);revision=read.get('session_context_revision')
  result=call('run_process',{'project':project,'executable':sys.executable,'args':['-B','-c','import time; time.sleep(2); print("native-readonly-adapter-check")'],'timeout_secs':20,'sync_wait_secs':1,'purpose':'diagnostic','session_id':session_id,'recording_session_id':session_id,**({'ack_session_context_revision':revision} if revision is not None else {})})
  job_id=result.get('job_id');check('one native background Job accepted',isinstance(job_id,str))
  observer=Observer(Transport(origin,key,'clw-wb0022-native'),cache_secs=0)
  state=observer.state(project,session_id)
  check('adapter reads native Session and activity',state['state']=='connected' and any(s['id']==session_id and s['activities_loaded'] for s in state['projection']['sessions']))
  for _ in range(20):
   if any(j['id']==job_id and j['status']=='completed' for j in (state.get('projection') or {}).get('jobs',[])):break
   time.sleep(.25);state=observer.state(project,session_id)
  check('native accepted Job observed completed once',sum(j['id']==job_id and j['status']=='completed' and j['exit_code']==0 for j in state['projection']['jobs'])==1)
  receipts={'project_id':project,'session_id':session_id,'job_id':job_id,'projection':state['projection'],'coverage':state['coverage']}
  encoded=json.dumps(receipts,ensure_ascii=False);check('native projection excludes secret',key not in encoded)
  (evidence/'native-projection.json').write_text(encoded,encoding='utf-8')
  from playwright.sync_api import sync_playwright
  workbench=create_server(0,observer);workbench_thread=threading.Thread(target=workbench.serve_forever,daemon=True);workbench_thread.start()
  pw=sync_playwright().start();browser=pw.chromium.launch(channel='msedge',headless=True);context=browser.new_context(viewport={'width':1480,'height':1120});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(f'http://127.0.0.1:{workbench.server_address[1]}/?live=1');page.wait_for_function("() => document.querySelector('#projectCount').textContent==='2'")
  page.locator(f'[data-project-id="{project}"]').click();page.wait_for_function("() => document.querySelector('#sessionCount').textContent==='1'")
  page.get_by_role('button',name='查看调用 →').click();page.wait_for_function("() => document.querySelector('#timelineSummary').textContent.startsWith('当前Session活动') && document.querySelector('#liveState').dataset.state==='connected'")
  check('native browser timeline renders selected Session',page.locator('#timelineSession').input_value()==session_id and page.locator('#eventRows tr').count()>0 and errors==[])
  check('historical accepted call is correlated to current completed Job', '最新 Job：completed / exit 0' in page.locator('#eventRows').inner_text())
  page.screenshot(path=str(evidence/'native-live-timeline.png'),full_page=True)
  page.locator('[data-view=overview]').click();page.screenshot(path=str(evidence/'native-live-overview.png'),full_page=True)
  check('no credential stored in browser',key not in page.content() and key not in page.evaluate('() => JSON.stringify(localStorage)'))
  context.close();report['status']='passed'
 except Exception as exc:
  report['status']='failed';report['failure_type']=type(exc).__name__;report['message']='Native verification did not complete; inspect local test logs without sharing secrets.'
  print('Native check failed:',type(exc).__name__,str(exc)[:300] if isinstance(exc,AssertionError) else '',flush=True)
 finally:
  if browser:browser.close()
  if pw:pw.stop()
  if workbench:workbench.shutdown();workbench.server_close();workbench_thread.join(timeout=3)
  for process in reversed(children):
   if process.stdin:process.stdin.close()
   try:process.wait(timeout=2)
   except subprocess.TimeoutExpired:subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True,timeout=10)
  for h in handles:h.close()
  report.update(recorded_at=datetime.now(timezone.utc).isoformat(),recorded_child_pids=[p.pid for p in children],isolated_children_stopped=all(p.poll() is not None for p in children),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
  (evidence/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
  (ROOT/'evidence/WB002-2/latest-native.txt').write_text(evidence.relative_to(ROOT).as_posix()+'\n')
  print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
 return 0 if report.get('status')=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
