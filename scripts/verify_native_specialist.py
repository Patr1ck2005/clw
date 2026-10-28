"""WB002.4 native Server/Runner + no-model ACP protocol acceptance.
Reuses only caller-selected published binaries. All users, tokens, projects,
processes and databases belong to a fresh test directory. Never reads stable
credentials or invokes Codex/OpenAI. Not a substitute for real account acceptance.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from urllib.request import Request,build_opener,ProxyHandler
from urllib.error import HTTPError
from live_transport import Transport,NoRedirect
from live_observer import Observer
from coding_agent_bridge import NativeAgentBridge
from task_store import TaskStore
from specialist_service import Specialists
from usage_store import UsageStore
from serve_control_center import create_server
ROOT=Path(__file__).resolve().parents[1]


def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--binary-dir',type=Path,required=True);args=parser.parse_args()
    binaries=args.binary_dir.resolve();exe=binaries/'webcodex.exe';runner=binaries/'webcodex-runner.exe'
    for p in [exe,runner,binaries/'webcodex-server.exe']:
        if not p.is_file():raise SystemExit('Caller-selected published binary missing')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    base=ROOT/'.local/WB0024-native'/stamp;base.mkdir(parents=True)
    evidence=ROOT/'evidence/WB002-4/native'/stamp;evidence.mkdir(parents=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    env={k:v for k,v in os.environ.items() if not k.upper().startswith(('WEBCODEX_','CLW_','OPENAI_','CODEX_'))}
    env.update(PYTHONUTF8='1',NO_PROXY='127.0.0.1,localhost');env.pop('HTTP_PROXY',None);env.pop('HTTPS_PROXY',None);env.pop('ALL_PROXY',None)
    # Native ACP has a separate per-user durable state directory. Redirect it
    # too, not just Server data and Runner TOML, so future verifier runs cannot
    # leave even a test namespace in the operator's ordinary application cache.
    for key,suffix in {'HOME':'profile','USERPROFILE':'profile','LOCALAPPDATA':'profile/local','APPDATA':'profile/roaming','XDG_STATE_HOME':'profile/state','XDG_CONFIG_HOME':'profile/config','TEMP':'tmp','TMP':'tmp'}.items():
        directory=base/suffix;directory.mkdir(parents=True,exist_ok=True)
        # Native atomic publish uses Windows path APIs: the nested run digests
        # exceed MAX_PATH under this repository. Keep the isolated directory;
        # use the explicit extended-length spelling instead of widening scope.
        env[key]=('\\\\?\\'+str(directory)) if os.name=='nt' else str(directory)
    checks=[];children=[];logs=[];workbench=None;thread=None;browser=None;pw=None
    source_files=[f for root in ('apps/control-center','scripts','tests') for f in (ROOT/root).rglob('*') if f.is_file() and '__pycache__' not in f.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
    report={'kind':'published native 0.4.1 Server/Runner with controlled no-model ACP stdio process','real_codex_account_test':False,'real_model_calls':0,'stable_config_read':False,'stable_processes_restarted':False,'native_state_profile_isolated':True,'checks':checks}
    def check(name,passed):
        checks.append({'name':name,'passed':bool(passed)});print(name, bool(passed),flush=True)
        if not passed:raise AssertionError(name)
    def cli(argv,label):
        p=subprocess.run([str(exe),*argv],cwd=base,env=env,capture_output=True,timeout=25)
        (base/(label+'.stdout')).write_bytes(p.stdout);(base/(label+'.stderr')).write_bytes(p.stderr)
        if p.returncode:raise AssertionError('Isolated CLI failed: '+label+'; test-only private logs retained')
        return json.loads(p.stdout) if p.stdout.strip().startswith(b'{') else None
    def token(value,prefix):
        found=[]
        def walk(v):
            if isinstance(v,dict):
                for x in v.values():walk(x)
            elif isinstance(v,list):
                for x in v:walk(x)
            elif isinstance(v,str) and v.startswith(prefix) and len(v)>30:found.append(v)
        walk(value)
        if len(set(found))!=1:raise AssertionError('Isolated CLI token response not recognized')
        return found[0]
    opener=build_opener(ProxyHandler({}),NoRedirect())
    def post(path,data,key):
        req=Request(origin+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
        with opener.open(req,timeout=15) as r:return json.loads(r.read(2*1024*1024))
    try:
        cli(['server','init','--listen',f'127.0.0.1:{port}','--data-dir',str(base/'data'),'--env-file',str(base/'server.env'),'--json'],'init')
        # This key is generated by this test, never an existing user credential.
        pairs={k:v.strip().strip('"') for line in (base/'server.env').read_text().splitlines() if '=' in line and not line.startswith('#') for k,v in [line.split('=',1)]}
        admin=pairs['WEBCODEX_TOKEN'];adminfile=base/'test-admin-key';adminfile.write_text(admin)
        log=(base/'server.log').open('wb');logs.append(log);children.append(subprocess.Popen([str(exe),'server','run','--env-file',str(base/'server.env')],cwd=base,env=env,stdin=subprocess.PIPE,stdout=log,stderr=log))
        ready=False
        for _ in range(35):
            try:
                status=post('/api/runtime/status',{'compact':True},admin);ready=status.get('success') is True
                if ready:break
            except (OSError,ValueError):pass
            time.sleep(.2)
        check('isolated published Server initialized',ready)
        common=['--server-url',origin,'--token-file',str(adminfile),'--no-system-proxy']
        cli(['users','create',*common,'--username','clw-native-acceptance','--role','admin'],'create-user')
        scopes=['runtime:read','project:read','project:write','coding_agent:run']
        data=cli(['tokens','create',*common,'--username','clw-native-acceptance',*[v for s in scopes for v in ('--scope',s)]],'create-user-token');userkey=token(data,'wc_pat_')
        data=cli(['runner-tokens','create',*common,'--username','clw-native-acceptance','--client-id','clw-wb0024-native'],'create-runner-token');runnerkey=token(data,'wc_agent_')
        check('isolated user and dedicated scoped runtime credentials created',bool(userkey and runnerkey))
        projectroot=base/'project';projectroot.mkdir();(projectroot/'AGENTS.md').write_text('Isolated no-model ACP acceptance. No external projects.\n')
        registry=base/'registry';registry.mkdir();(registry/'test.toml').write_text('id = "test"\nname = "CLW isolated specialist test"\npath = '+json.dumps(projectroot.as_posix())+'\nallow_patch = true\n')
        conf='server_url = '+json.dumps(origin)+'\ntoken = '+json.dumps(runnerkey)+'\nclient_id = "clw-wb0024-native"\nowner = "clw-native-acceptance"\nproject_registry_dir = '+json.dumps(registry.as_posix())+'\npoll_interval_ms = 500\n[policy]\nallowed_roots = ['+json.dumps(projectroot.as_posix())+']\nallow_raw_shell = false\nallow_cwd_anywhere = false\nmax_timeout_secs = 60\nmax_output_bytes = 16384\n[acp]\nmax_concurrent_runs = 1\npermission_timeout_secs = 2\n[[acp.agents]]\nid = "clw-test-acp"\nname = "CLW no-model protocol peer"\nexecutable = '+json.dumps(sys.executable)+'\nargs = ["-B",'+json.dumps(str(ROOT/'tests/native_acp_fixture.py'))+','+json.dumps(str(base/'peer.jsonl'))+']\nallowed_config_options = ["model","reasoning_effort","mode"]\n'
        (base/'runner.toml').write_text(conf,encoding='utf-8')
        log=(base/'runner.log').open('wb');logs.append(log);children.append(subprocess.Popen([str(runner),'--config',str(base/'runner.toml'),'--stop-on-stdin-eof'],cwd=base,env=env,stdin=subprocess.PIPE,stdout=log,stderr=log))
        transport=Transport(origin,userkey,'clw-wb0024-native');bridge=NativeAgentBridge(transport,enabled=True,provider_ids=['clw-test-acp']);project='agent:clw-wb0024-native:test';caps=None
        for _ in range(40):
            try:
                caps=bridge.discover(project)
                if caps['available']:break
            except Exception:pass
            time.sleep(.2)
        check('published Runner confirms ACP capability with explicit local provider candidate',caps is not None and caps['native_run_capability'] and caps['available'] and caps['providers'][0]['id']=='clw-test-acp')
        check('missing native Provider details are not fabricated as verified advertising',caps['provider_details_available'] is False and caps['providers'][0]['advertisement_verified'] is False)
        obs=Observer(transport,cache_secs=0);state=obs.state(project)
        check('formal read-only adapter sees exact isolated project',state['state']=='connected' and any(p['id']==project for p in state['projection']['projects']))
        # Test-only wire capture: all instructions and users were created above.
        # Raw errors stay in this fresh private test directory, never in the UI.
        original_call=bridge.call
        def diagnostic_call(tool,params):
            try:
                value=original_call(tool,params)
                if tool.startswith('coding_agent_'):
                    with (base/'native-replies.jsonl').open('a',encoding='utf-8') as log:log.write(json.dumps({'tool':tool,'result':value},ensure_ascii=False)+'\n')
                return value
            except Exception as exc:
                (base/'native-exception.json').write_text(json.dumps({'type':type(exc).__name__,'message':str(exc)}),encoding='utf-8');raise
        bridge.call=diagnostic_call
        store=TaskStore(base/'tasks.sqlite3',obs);service=Specialists(store,bridge);task=None
        def regular(action,data):
            nonlocal task
            raw={'request_id':str(uuid.uuid4()),'action':action,'actor':'native acceptance','data':data}
            if task:raw.update(task_id=task['id'],expected_version=task['version'])
            task=store.command(raw)['task'];return task
        def command(action,data):
            nonlocal task
            task=store.get(task['id']);raw={'request_id':str(uuid.uuid4()),'action':action,'actor':'native acceptance','task_id':task['id'],'expected_version':task['version'],'data':data}
            result=service.command(raw);task=store.get(task['id']);return raw,result
        c={'title':'Published native ACP acceptance','goal':'Preserve this whole instruction; perform protocol-only no-model acceptance.','constraints':'No network, model, real account or external project access.','baseline':'0.4.1 published binaries','sources':'test source and pinned protocol','mode':'hybrid','coordinator':'test','acceptance':['native Run terminal observed'],'roles':[{'id':'R','name':'ACP peer','objective':'Controlled no-model protocol exchange','executor':'codex','project_id':project,'project_root':projectroot.as_posix(),'worktree':projectroot.as_posix(),'access':'read','scopes':[],'depends_on':[]}]}
        regular('create',{'contract':c});regular('publish',{});regular('claim',{'role_id':'R','external_ref':'isolated fixture only; not Codex'})
        command('prepare',{'role_id':'R','provider':caps['providers'][0]['id'],'binding':caps['providers'][0]['binding'],'config':{'model':'clw-no-model','reasoning_effort':'max','mode':'read-only'},'billing':'work_codex','account_alias':'test identity; no actual bill'})
        check('preparation does not start the peer',not (base/'peer.jsonl').exists())
        original,receipt=command('start',{'role_id':'R','confirmed':True})
        for _ in range(45):
            d=store.get(task['id'])['roles']['R']['delegation']
            if d.get('run_id') and d['phase'] not in {'completed','failed','not_started','cancelled'}:command('observe',{'role_id':'R'})
            d=store.get(task['id'])['roles']['R']['delegation']
            if d['phase'] in {'completed','failed','not_started','cancelled'}:break
            time.sleep(.2)
        (base/'private-task.json').write_text(json.dumps(store.get(task['id'])),encoding='utf-8')
        check('actual native Run completed with correlated terminal',d['phase']=='completed' and d.get('terminal',{}).get('stop_reason')=='end_turn')
        check('native durable Run state remains in explicit test profile',any((base/'profile/local/webcodex/runner-coding-agent-runs-v1').rglob('*.json')))
        # A start response may already be terminal; explicitly read the retained events.
        command('observe',{'role_id':'R'});d=store.get(task['id'])['roles']['R']['delegation']
        events=[json.loads(l) for l in (base/'peer.jsonl').read_text().splitlines()]
        prompts=[e for e in events if e['kind']=='prompt'];check('exact options negotiated before one original prompt',len(prompts)==1 and prompts[0]['config']=={'model':'clw-no-model','reasoning_effort':'max','mode':'read-only'})
        check('complete frozen instruction reached native peer',prompts[0]['sha256']==hashlib.sha256(d['instruction'].encode()).hexdigest())
        service.command(original);check('original UI receipt replay never prompts twice',len([json.loads(l) for l in (base/'peer.jsonl').read_text().splitlines() if json.loads(l)['kind']=='prompt'])==1)
        check('native cumulative usage retained without summing',d.get('usage',{}).get('used_tokens')==70 and d.get('usage',{}).get('cost_amount') in ('0.05','0.050'))
        check('requested model is not misrepresented as observed model',d.get('effective_model') is None)
        check('native completion does not accept parent or submit role',store.get(task['id'])['status']=='open' and store.get(task['id'])['roles']['R']['status']=='running')
        restored=TaskStore(base/'tasks.sqlite3',obs);check('exact Run and original receipt survive product DB reopen',restored.get(task['id'])['roles']['R']['delegation']['run_id']==d['run_id'] and restored.receipt(original['request_id'])['found'])
        unsupported={'project':project,'provider_id':'clw-test-acp','idempotency_key':'clw-test-unsupported-'+uuid.uuid4().hex,'instruction':'Never reaches prompt: unsupported exact model','config':{'model':'unsupported-model'},'timeout_secs':30}
        rejected=bridge.call('coding_agent_start',unsupported)
        rejected_run=rejected.get('output',{}).get('run_id')
        for _ in range(25):
            output=rejected.get('output',{})
            if output.get('terminal') or rejected.get('success') is False:break
            if rejected_run:rejected=bridge.call('coding_agent_observe',{'run_id':rejected_run,'wait_secs':0})
            time.sleep(.2)
        output=rejected.get('output',{})
        check('unsupported config rejected before native prompt without fallback',output.get('execution_state')=='not_started' and len([json.loads(l) for l in (base/'peer.jsonl').read_text().splitlines() if json.loads(l)['kind']=='prompt'])==1)
        from playwright.sync_api import sync_playwright
        workbench=create_server(0,obs,store,service,UsageStore(base/'usage.sqlite3'));thread=threading.Thread(target=workbench.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{workbench.server_address[1]}/'
        pw=sync_playwright().start();browser=pw.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1480,'height':1080});page=ctx.new_page();errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda q:requests.append(q.url))
        page.goto(url+'specialists.html');page.wait_for_function("() => document.querySelectorAll('.ledger-card').length===3");page.locator('#specialistTask').select_option(task['id']);page.wait_for_function("() => document.querySelector('#nativeRun').textContent.includes('专项状态：completed')")
        check('real browser shows native completed Run and unknown quota',d['run_id'] in page.locator('#nativeRun').inner_text() and page.locator('.ledger-card strong').all_text_contents()==['官方余量未知']*3)
        check('browser contains no runtime or test admin credentials',all(k not in page.content()+page.evaluate('() => JSON.stringify(localStorage)+JSON.stringify(sessionStorage)') for k in [admin,userkey,runnerkey]))
        for width in (1480,390):
            page.set_viewport_size({'width':width,'height':1080});check('no horizontal overflow '+str(width),page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));page.screenshot(path=str(evidence/f'native-specialist-{width}.png'),full_page=True)
        check('no script errors or external browser requests',not errors and all(u.startswith(url) for u in requests))
        report.update(status='passed',project_id=project,run_id=d['run_id'],provider_id=d['provider'],public_delegation={k:v for k,v in d.items() if k not in {'instruction','observation_token','provider_binding'}},protocol_events=events)
        ctx.close()
    except Exception as exc:
        report.update(status='failed',failure_type=type(exc).__name__,failed_check=str(exc) if isinstance(exc,AssertionError) else 'Inspect isolated private logs; no real credential data collected')
        print('NATIVE_ACCEPTANCE_FAILED',report['failed_check'],flush=True)
    finally:
        if browser:browser.close()
        if pw:pw.stop()
        if workbench:workbench.shutdown();workbench.server_close();thread.join(timeout=3)
        for child in reversed(children):
            if child.stdin:child.stdin.close()
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True,timeout=15)
        for f in logs:f.close()
        report.update(recorded_at=datetime.now(timezone.utc).isoformat(),isolated_child_pids=[p.pid for p in children],isolated_children_stopped=all(p.poll() is not None for p in children),source_hashes=hashes,sources_unchanged=all((ROOT/p).is_file() and hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in hashes.items()))
        if not report['sources_unchanged'] or not report['isolated_children_stopped']:report['status']='failed'
        (evidence/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-4/latest-native.txt').write_text(evidence.relative_to(ROOT).as_posix()+'\n')
        print('NATIVE_SPECIALIST_EVIDENCE',evidence.relative_to(ROOT).as_posix(),report['status'],len(checks),flush=True)
    return 0 if report.get('status')=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
