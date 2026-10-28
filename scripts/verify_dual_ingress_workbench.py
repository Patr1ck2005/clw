"""Real A/B health + existing read-only observer + isolated candidate account UI. No secrets/models."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,subprocess,sys,threading,uuid
from urllib.parse import urlencode
from urllib.request import build_opener,ProxyHandler
from live_transport import NoRedirect,validate_origin,ObservationError
from ingress_health import IngressSources,IngressHealth
from account_store import AccountStore
from task_domain import TaskError
from serve_control_center import create_server
ROOT=Path(__file__).resolve().parents[1]

class ObserverRelay:
    def __init__(self,base):self.base=validate_origin(base);self.calls=[]
    def get(self,path,params=None):
        url=self.base+path+('?' + urlencode(params) if params else '')
        try:
            with build_opener(ProxyHandler({}),NoRedirect()).open(url,timeout=28) as r:
                data=r.read(2*1024*1024+1)
                if len(data)>2*1024*1024:raise ValueError('oversized')
                return json.loads(data)
        except Exception:raise ObservationError('upstream_unreachable') from None
    def info(self):return self.get('/api/live/info')
    def state(self,project='',session='',**kwargs):
        self.calls.append({'project':project,'session':session});return self.get('/api/live/state',{'project':project,'session':session})

def processes():
    cmd="Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('webcodex-server.exe','webcodex-runner.exe','tunnel-client.exe')} | Select-Object Name,ProcessId,CreationDate | Sort-Object ProcessId | ConvertTo-Json -Compress"
    p=subprocess.run(['powershell','-NoProfile','-Command',cmd],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=20,check=True)
    return json.loads(p.stdout)

def main():
    from playwright.sync_api import sync_playwright
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--ingress-sources',type=Path,required=True);p.add_argument('--observer-origin',default='http://127.0.0.1:18940');p.add_argument('--project',required=True);p.add_argument('--session',required=True);a=p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');out=ROOT/'evidence/WB002-4A/stable'/stamp;out.mkdir(parents=True);local=ROOT/'.local/WB0024A-stable'/stamp;local.mkdir(parents=True)
    paths=[p for d in ('apps/control-center','scripts','tests') for p in (ROOT/d).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};checks=[];server=None;thread=None;report={};before=processes()
    def check(name,result):
        checks.append({'name':name,'passed':bool(result)})
        if not result:raise AssertionError(name)
    try:
        sources=IngressSources.load(a.ingress_sources);check('exactly_two_explicit_sources',set(sources.entries)=={'account-a','account-b'});observer=ObserverRelay(a.observer_origin);info=observer.info();check('existing_read_only_observer',info.get('configured') and info.get('read_only'))
        check('same_existing_backend_identity',all(s['connection_id']==info['connection_id'] for s in sources.entries.values()))
        health=IngressHealth(sources);states={sid:health.observe(sid) for sid in sources.entries};report['actual_ingress_observations']=states
        for sid,h in states.items():check(sid+'_recent_identity_matched_poll',h['state']=='polling' and h['tunnel_identity']=='metric_match' and h['poll_age_secs']<=90)
        store=AccountStore(local/'accounts.sqlite3',sources,observer,health)
        def cmd(action,data,acct=None,rid=None):
            raw={'request_id':rid or str(uuid.uuid4()),'action':action,'actor':'本轮开发者明确登记；非平台身份认证','data':data}
            if acct:raw.update(account_id=acct['id'],expected_version=acct['version'])
            return store.command(raw)
        accounts={}
        for sid,title in [('account-a','Pro-A · 当前入口'),('account-b','Pro-B · 第二入口')]:
            rid=str(uuid.uuid4());data={'source_id':sid,'name':title,'browser_hint':'本地标注，未读取浏览器','notes':'用户已报告两账号均真实使用；此处只验证入口和本地组织功能'};r=cmd('create',data,rid=rid);accounts[sid]=r['account'];check(sid+'_create_same_id_replay',cmd('create',data,rid=rid)['account']['id']==r['account']['id'])
        sa=accounts['account-a'];sb=accounts['account-b'];real=store.inspect(sa['id'],a.project,a.session)['observation'];report['project_count']=len(real['projection']['projects']);check('actual_project_and_exact_session',any(s['id']==a.session for s in real['projection']['sessions']))
        bind={'project_id':a.project,'session_id':a.session,'connection_id':info['connection_id'],'role':'WB002.4A 开发者','notes':'本次Session由账号A当前对话实际work_on_project取得；这是明确来源声明，不是后台账号认证','confirmed':True}
        sa=cmd('bind',bind,sa)['account'];bid=store.bindings(sa['id'])[0]['id'];detail=store.activity(sa['id'],bid);report['activity_returned']=len(detail['session']['activities']);report['activity_total']=detail['session']['activity_total'];check('native_session_activity_read',len(detail['session']['activities'])>0);check('B_does_not_inherit_A_session',store.bindings(sb['id'])==[])
        denied=False
        try:cmd('bind',bind,sb)
        except TaskError as exc:denied=exc.code=='binding_conflict'
        check('no_cross_account_steal',denied)
        recovered=AccountStore(local/'accounts.sqlite3',sources,observer,health);check('persistent_profile_and_session',len(recovered.listing()['accounts'])==2 and recovered.bindings(sa['id'])[0]['id']==bid)
        server=create_server(0,observer=observer,account_store=store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url='http://127.0.0.1:'+str(server.server_address[1])+'/'
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1480,'height':1100});page=ctx.new_page();errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url))
            try:
                page.goto(url+'accounts.html');page.wait_for_function("() => document.querySelectorAll('.account-card').length===2");page.wait_for_function("() => [...document.querySelectorAll('.account-card')].every(x=>x.textContent.includes('云端轮询正常'))");check('actual_both_tunnels_visible',page.locator('.account-card').count()==2)
                page.screenshot(path=str(out/'dual-accounts-1480.png'),full_page=True)
                page.get_by_role('button',name='查看独立时间线',exact=True).click();page.wait_for_function('(id)=>document.querySelector("#accountActivity").textContent.includes(id)',arg=a.session);check('exact_session_in_real_browser',a.session in page.locator('#accountActivity').inner_text());page.screenshot(path=str(out/'session-activity-1480.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':1100});check('narrow_no_horizontal_overflow',page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));page.screenshot(path=str(out/'dual-accounts-390.png'),full_page=True)
                page.locator('[data-account-id="'+sb['id']+'"]').click();page.wait_for_function("() => document.querySelector('#accountTitle').textContent.includes('Pro-B')");check('selected_B_does_not_show_A_history',a.session not in page.locator('#accountActivity').inner_text());check('B_without_fabricated_session',page.locator('.bound-session').count()==0)
                page.locator('#pauseAccounts').click();page.wait_for_timeout(200);count=len(observer.calls);page.clock.install();page.clock.fast_forward(16000);check('pause_no_more_backend_reads',len(observer.calls)==count)
                check('no_page_errors',errors==[]);check('candidate_browser_same_origin_only',all(u.startswith(url) or u.startswith('blob:') for u in requests));check('no_post_on_observation',len(store.history(sa['id'])['events'])==2 and len(store.history(sb['id'])['events'])==1)
            finally:ctx.close();browser.close()
        report['status']='passed'
    except Exception as exc:report['status']='failed';report['failure_type']=type(exc).__name__;report['failure_message']=str(exc)[:1000];print('FAIL',type(exc).__name__,str(exc)[:1000])
    finally:
        if server:server.shutdown();server.server_close()
        if thread:thread.join()
        after=processes();check_process=before==after;checks.append({'name':'original_server_runner_tunnel_processes_unchanged','passed':check_process})
        same=all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items());checks.append({'name':'covered_sources_unchanged','passed':same})
        if not check_process or not same:report['status']='failed'
        report.update(recorded_at=datetime.now(timezone.utc).isoformat(),checks=checks,source_hashes=hashes,sources_unchanged=same,processes_before=before,processes_after=after,real_model_calls=0,credential_files_read=False,candidate_closed=True,actual_B_session_attribution=False,session_id=a.session,scope='actual two ingress metrics + official current Session through already-linked observer + isolated candidate local metadata')
        (out/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-4A/latest-stable.txt').write_text(out.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('WB0024A_STABLE',out.relative_to(ROOT).as_posix(),report['status'],len(checks));return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
