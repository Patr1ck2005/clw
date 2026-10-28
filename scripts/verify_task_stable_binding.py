"""WB002.3 acceptance: isolated candidate task DB + existing user-linked workbench GET.
No credential files, new WebCodex sessions, runtime writes or service restarts.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sys
import threading
import uuid
from urllib.parse import urlencode
from urllib.request import Request,build_opener,ProxyHandler
from live_transport import validate_origin,NoRedirect,MAX_BODY
from task_store import TaskStore
from serve_control_center import create_server
ROOT=Path(__file__).resolve().parents[1]

class WorkbenchRelay:
    def __init__(self,origin,project):
        self.origin=validate_origin(origin);self.project=project;self.requests=0
        self.opener=build_opener(ProxyHandler({}),NoRedirect())
    def get(self,name,params=None):
        if name not in ('info','state'):raise ValueError('Only fixed GET observations')
        url=self.origin+'/api/live/'+name+('?' + urlencode(params) if params else '')
        with self.opener.open(Request(url,headers={'Accept':'application/json'}),timeout=28) as response:
            self.requests+=1
            if response.headers.get_content_type()!='application/json':raise ValueError('Expected observation JSON')
            body=response.read(MAX_BODY+32769)
            if len(body)>MAX_BODY+32768:raise ValueError('Observation too large')
        value=json.loads(body)
        if not isinstance(value,dict):raise ValueError('Invalid observation')
        return value
    def info(self):return self.get('info')
    def state(self,project='',session='',query='',after=''):
        if project not in ('',self.project):raise ValueError('Acceptance reads only the specified project')
        return self.get('state',{'project':project,'session':session,'query':query,'after':after})

def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',required=True);p.add_argument('--project',required=True);p.add_argument('--session',required=True);a=p.parse_args()
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');e=ROOT/'evidence/WB002-3/stable'/stamp;e.mkdir(parents=True)
    dbpath=ROOT/'.local/WB0023-acceptance'/stamp/'tasks.sqlite3'
    relay=WorkbenchRelay(a.url,a.project);checks=[];server=None;thread=None;browser=None;pw=None
    files=[f for root in ('apps/control-center','scripts','tests') for f in (ROOT/root).rglob('*') if f.is_file() and '__pycache__' not in f.parts]
    hashes={f.relative_to(ROOT).as_posix():hashlib.sha256(f.read_bytes()).hexdigest() for f in files}
    report={'kind':'isolated candidate task lifecycle with actual user-linked Session observation','checks':checks,'credential_files_read':False,'runtime_mutations':False,'model_calls':0,'game_files_touched':False,'user_workbench_restarted':False}
    def check(name,truth):
        checks.append({'name':name,'passed':bool(truth)})
        if not truth:raise AssertionError(name)
    try:
        info=relay.info();check('Existing linked workbench is configured and read-only',info.get('configured') is True and info.get('read_only') is True)
        observed=relay.state(a.project,a.session);check('Current Project/Session observation is valid',observed.get('state')=='connected' and observed.get('projection') is not None)
        projection=observed['projection'];project=next(x for x in projection['projects'] if x['id']==a.project)
        check('Exact active Session belongs to selected Project',any(s['id']==a.session and s['project_id']==a.project and s['lifecycle']=='active' for s in projection['sessions']))
        store=TaskStore(dbpath,relay);server=create_server(0,relay,store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{server.server_address[1]}'
        report.update(candidate_origin=url,source_workbench=a.url,project_id=a.project,session_id=a.session,connection_id=observed['connection_id'],source_observed_at=observed['observed_at'])
        opener=build_opener(ProxyHandler({}),NoRedirect())
        def get(route):
            with opener.open(url+route,timeout=30) as response:return json.load(response)
        intent=get('/api/tasks/info')['intent'];task=None;requests=[]
        def command(action,data,request_id=None):
            nonlocal task
            raw={'request_id':request_id or str(uuid.uuid4()),'action':action,'actor':'WB002.3本机验收','data':data}
            if task:raw.update(task_id=task['id'],expected_version=task['version'])
            req=Request(url+'/api/tasks/command',data=json.dumps(raw).encode(),headers={'Origin':url,'Content-Type':'application/json','X-CLW-Intent':intent},method='POST')
            with opener.open(req,timeout=30) as response:value=json.load(response)
            check('Metadata '+action+' committed with exact receipt',value.get('success') is True and value.get('request_id')==raw['request_id'])
            requests.append(raw['request_id']);task=value['task'];return raw,value
        c={'title':'[验收] 完整任务与真实会话关联','goal':'核对真实Session后，完成本地完整任务从发布、交接到逐条验收。\n不在真实项目额外执行开发或写入。','constraints':'不启动模型、命令或新上游Session；不读取凭据。','baseline':'当前产品候选；来源时间'+observed['observed_at'],'sources':'本轮现有Session与已运行工作台GET观测','mode':'pure_web','coordinator':'产品验收',
          'acceptance':['真实Session绑定准确','完成交接和父验收；重启后记录与回执一致'],
          'roles':[{'id':'W','name':'会话关联核验','objective':'核对本轮真实会话，提交验证引用。','executor':'web','project_id':a.project,'project_root':project['path'],'worktree':project['path'],'access':'read','scopes':[],'depends_on':[]}]}
        raw,created=command('create',{'contract':c});command('publish',{})
        from playwright.sync_api import sync_playwright
        pw=sync_playwright().start();browser=pw.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1480,'height':1080});page=ctx.new_page();errors=[];network=[];page.on('pageerror',lambda err:errors.append(str(err)));page.on('request',lambda req:network.append(req.url))
        page.goto(url+'/tasks.html');page.wait_for_function("() => document.querySelector('#taskStoreState').textContent.includes('已连接')")
        page.locator('#taskActor').fill('产品验收');page.locator(f'[data-task-id="{task["id"]}"]').click();page.get_by_role('button',name='核对 / 绑定 Session',exact=True).click();page.locator('[name=session_choice]').select_option(a.session);page.locator('#saveTaskAction').click();page.wait_for_function("() => !document.querySelector('#taskAction').open")
        task=store.get(task['id']);check('Actual browser bound verified native Session',task['roles']['W']['binding']['session_id']==a.session and task['roles']['W']['binding']['connection_id']==observed['connection_id'])
        command('claim',{'role_id':'W'});command('checkpoint',{'role_id':'W','completed':'真实会话绑定已核对','remaining':'记录交接与父验收','next_step':'对账原请求','original_jobs':'验证自身Local-MCP Job；不创建额外Job'})
        check('Checkpoint preserves running parent goal',task['roles']['W']['status']=='running' and task['contract']['goal']==c['goal'])
        command('submit',{'role_id':'W','contract_version':1,'summary':'已实际完成Session读取与元数据流程核验','changes':'仅候选临时任务库变化；不改真实工程','tests':'当前verification.json逐项检查','limitations':'这是产品流程验收，不是游戏功能验收','artifacts':e.relative_to(ROOT).as_posix(),'stopped_writing':True})
        check('Handoff does not auto-accept parent',task['status']=='open' and task['roles']['W']['status']=='submitted')
        page.locator('#refreshTasks').click();page.get_by_role('button',name='审阅交接',exact=True).click();page.locator('[name=note]').fill('核对真实绑定来源与本地交接记录');page.locator('#saveTaskAction').click();page.wait_for_function("() => !document.querySelector('#taskAction').open")
        page.get_by_role('button',name='逐条验收父任务',exact=True).click()
        for i in range(2):page.locator(f'[name=passed_{i}]').check();page.locator(f'[name=evidence_{i}]').fill('本轮独立产品验证记录 #'+str(i+1))
        page.locator('[name=note]').fill('逐条核对；不是模型自动判断成功');page.locator('#saveTaskAction').click();page.wait_for_function("() => !document.querySelector('#taskAction').open")
        task=store.get(task['id']);check('Browser reviewer explicitly accepts every criterion',task['status']=='accepted' and len(task['acceptance_review']['checks'])==2)
        # Same original create request is retried byte-for-byte only to validate metadata idempotency.
        original=Request(url+'/api/tasks/command',data=json.dumps(raw).encode(),headers={'Origin':url,'Content-Type':'application/json','X-CLW-Intent':intent},method='POST')
        with opener.open(original,timeout=15) as response:replayed=json.load(response)
        check('Accepted original request returns same receipt not another task',replayed['task_id']==task['id'] and replayed['version']==created['version'] and replayed['replayed'] is True and len(store.listing()['tasks'])==1)
        reopened=TaskStore(dbpath,relay);check('Reopened task database preserves full task and receipts',reopened.get(task['id'])==task and reopened.receipt(requests[0])['receipt']['task_id']==task['id'])
        exported=store.export(task['id'],'W','markdown');check('Role packet preserves full goal and exact Session',c['goal'] in exported['content'] and a.session in exported['content'])
        (e/'accepted-task.json').write_text(store.export(task['id'])['content'],encoding='utf-8');(e/'role-packet.md').write_text(exported['content'],encoding='utf-8')
        page.screenshot(path=str(e/'accepted-task-1480.png'),full_page=True);page.set_viewport_size({'width':390,'height':1080});page.screenshot(path=str(e/'accepted-task-390.png'),full_page=True)
        check('Narrow viewport has no horizontal overflow',page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'))
        check('No script errors or external browser requests',not errors and all(u.startswith(url+'/') or u.startswith('blob:') for u in network))
        check('Unchanged sources throughout acceptance',all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items()))
        report.update(status='passed',task_id=task['id'],task_store_id=store.store_id,task_events=len(store.events(task['id'],limit=100)['events']),source_hashes=hashes,read_only_relay_requests=relay.requests)
        ctx.close()
    except Exception as exc:
        report.update(status='failed',failure_type=type(exc).__name__,failed_check=str(exc) if isinstance(exc,AssertionError) else 'See scoped local diagnostics; no credential data collected')
        print('ACCEPTANCE_FAILED',report['failed_check'],flush=True)
    finally:
        if browser:browser.close()
        if pw:pw.stop()
        if server:server.shutdown();server.server_close();thread.join(timeout=5)
        report['recorded_at']=datetime.now(timezone.utc).isoformat();report['candidate_server_stopped']=server is None or not thread.is_alive()
        (e/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        (ROOT/'evidence/WB002-3/latest-stable.txt').write_text(e.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
        print(json.dumps({k:v for k,v in report.items() if k!='source_hashes'},ensure_ascii=False,indent=2),flush=True)
        print('TASK_STABLE_EVIDENCE',e.relative_to(ROOT).as_posix(),flush=True)
    return 0 if report.get('status')=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
