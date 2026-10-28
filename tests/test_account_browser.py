"""Isolated real Edge: attribution, lost replies, conflicts and account switching. No real accounts used."""
from pathlib import Path
import json,os,sys,tempfile,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright
from account_store import AccountStore
from ingress_health import IngressSources
from account_fixture import source_entries,Observe,Health,P1,P2,S1,S2,CONNECTION
from serve_control_center import create_server
OUT=Path(os.environ.get('CLW_ACCOUNT_EVIDENCE_DIR',str(ROOT/'evidence/WB002-4A/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-4A').resolve()):raise ValueError('Scoped evidence only')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.observer=Observe();self.health=Health();self.store=AccountStore(Path(self.tmp.name)/'accounts.sqlite3',IngressSources(source_entries(self.tmp.name)),self.observer,self.health)
        self.a=self.command('create',{'source_id':'A','name':'Pro-A','browser_hint':'Edge A','notes':'user-confirmed history'});self.b=self.command('create',{'source_id':'B','name':'Pro-B','browser_hint':'Chrome B','notes':''})
        self.server=create_server(account_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_address[1])+'/'
        self.ctx=self.browser.new_context(viewport={'width':1480,'height':1080});self.p=self.ctx.new_page();self.errors=[];self.requests=[];self.p.on('pageerror',lambda e:self.errors.append(str(e)));self.p.on('request',lambda req:self.requests.append(req.url));self.goto()
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.assertTrue(all(u.startswith(self.url) or u.startswith('blob:') for u in self.requests));self.ctx.close();self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def command(self,action,data,a=None):
        r={'request_id':str(uuid.uuid4()),'action':action,'actor':'tester','data':data}
        if a:r.update(account_id=a['id'],expected_version=a['version'])
        return self.store.command(r)['account']
    def goto(self):
        self.p.goto(self.url+'accounts.html');self.p.wait_for_function("() => document.querySelectorAll('.account-card').length===2");self.p.wait_for_function("() => document.querySelector('#accountTitle').textContent==='Pro-A'")
    def binding(self,a,project,session):return self.command('bind',{'confirmed':True,'project_id':project,'session_id':session,'connection_id':CONNECTION,'role':'M','notes':'explicit test attribution'},a)
    def select(self,a):
        self.p.locator('[data-account-id="'+a['id']+'"]').click();self.p.wait_for_function('(name) => document.querySelector("#accountTitle").textContent===name',arg=a['name'])
    def test_opening_does_not_write_or_launch(self):
        self.assertEqual(len(self.store.history(self.a['id'])['events']),1);self.assertEqual(self.store.bindings(self.a['id']),[]);self.p.locator('.account-help summary').first.click();self.assertIn('最后由你确认来源账号',self.p.locator('.account-help').inner_text())
    def test_existing_profiles_shared_across_browser_contexts(self):
        other=self.browser.new_context();p=other.new_page();p.goto(self.url+'accounts.html');p.wait_for_function("() => document.querySelectorAll('.account-card').length===2");self.assertIn('Pro-B',p.locator('#accountCards').inner_text());other.close()
    def test_real_binding_flow_requires_confirmed_attribution(self):
        self.p.locator('#openBinding').click();self.p.wait_for_function("() => document.querySelector('#bindingNativeSession').value==='wc_sess_test_a'");self.p.locator('#bindingRole').fill('Web M');self.p.locator('#bindingNotes').fill('已在A网页核对Session');self.p.locator('#bindingConsent').check();self.p.locator('#saveSessionBinding').click();self.p.wait_for_function("() => !document.querySelector('#sessionBinding').open");self.assertEqual(len(self.store.bindings(self.a['id'])),1);self.p.get_by_role('button',name='查看独立时间线',exact=True).click();self.p.wait_for_function("() => document.querySelector('#accountActivity').textContent.includes('read_files')");self.assertIn('操作者确认',self.p.locator('#accountActivity').inner_text())
    def test_switching_account_clears_previous_timeline_immediately(self):
        self.binding(self.a,P1,S1);self.p.locator('#refreshAccounts').click();self.p.wait_for_function("() => document.querySelectorAll('.bound-session').length===1");self.p.get_by_role('button',name='查看独立时间线',exact=True).click();self.p.wait_for_function("() => document.querySelector('#accountActivity').textContent.includes('wc_sess_test_a')")
        held=[];pattern='**/api/accounts/dashboard?id='+self.b['id'];self.p.route(pattern,lambda route:held.append(route));self.p.locator('[data-account-id="'+self.b['id']+'"]').click();self.p.wait_for_timeout(100)
        try:self.assertNotIn(S1,self.p.locator('#accountActivity').inner_text())
        finally:
            for route in held:route.continue_()
            self.p.unroute(pattern)
    def test_conflicting_edit_keeps_draft(self):
        self.p.locator('#editAccount').click();self.p.locator('#accountName').fill('我的草稿');a=self.store.get(self.a['id']);self.command('update',{'name':'其他窗口已更新','browser_hint':'','notes':''},a);self.p.locator('#saveAccount').click();self.p.wait_for_function("() => document.querySelector('#accountEditorError').textContent.length>0");self.assertTrue(self.p.locator('#accountEditor').evaluate('(d)=>d.open'));self.assertEqual(self.p.locator('#accountName').input_value(),'我的草稿')
    def test_refresh_does_not_close_or_replace_editor(self):
        self.p.locator('#editAccount').click();self.p.locator('#accountName').fill('保留草稿');self.p.evaluate("() => document.querySelector('#refreshAccounts').click()");self.p.wait_for_timeout(250);self.assertEqual(self.p.locator('#accountName').input_value(),'保留草稿');self.assertTrue(self.p.locator('#accountEditor').evaluate('(d)=>d.open'))
    def test_reply_loss_recovery_never_duplicates_change(self):
        self.p.locator('#editAccount').click();self.p.locator('#accountName').fill('保存一次')
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/accounts/command',lose);self.p.locator('#saveAccount').click();self.p.wait_for_function("() => document.querySelector('#accountEditorError').textContent.includes('结果未知')");self.p.unroute('**/api/accounts/command',lose);self.p.locator('#closeAccountEditor').click();self.p.reload();self.p.wait_for_function("() => !document.querySelector('#pendingAccount').hidden");self.p.locator('#reconcileAccount').click();self.p.wait_for_function("() => document.querySelector('#pendingAccount').hidden");self.assertEqual(len(self.store.history(self.a['id'])['events']),2)
    def test_archive_does_not_end_session_or_tunnel(self):
        self.p.locator('#archiveAccount').click();self.p.locator('#accountActionReason').fill('只整理记录');self.p.locator('#accountActionGo').click();self.p.wait_for_function("() => !document.querySelector('#accountAction').open");self.assertTrue(self.store.get(self.a['id'])['archived']);self.assertEqual(self.health.state_name,'polling');self.assertEqual(self.observer.state_name,'connected')
    def test_unverified_and_missing_poll_show_different_status(self):
        self.health.state_name='poll_not_seen';self.p.locator('#refreshAccounts').click();self.p.wait_for_function("() => [...document.querySelectorAll('.account-card')].every(x=>x.textContent.includes('尚无成功云端轮询'))");self.assertIn('尚无成功云端轮询',self.p.locator('#ingressFacts').inner_text());self.assertNotIn('云端轮询正常',self.p.locator('#accountCards').inner_text())
    def test_pause_stops_periodic_queries_not_work(self):
        self.p.locator('#pauseAccounts').click();self.p.wait_for_timeout(250);n=len(self.health.calls);self.p.clock.install();self.p.clock.fast_forward(16000);self.assertEqual(len(self.health.calls),n);self.assertIn('已暂停观察',self.p.locator('#accountCards').inner_text())
    def test_export_has_no_credentials_or_local_health_path(self):
        with self.p.expect_download() as d:self.p.locator('#exportAccounts').click()
        data=Path(d.value.path()).read_text(encoding='utf-8');self.assertNotIn('health_url_file',data);self.assertNotIn(self.tmp.name,data);self.assertEqual(len(json.loads(data)['accounts']),2)
    def test_markup_is_text_and_wide_narrow_layout(self):
        a=self.store.get(self.a['id']);self.command('update',{'name':'<img src=x onerror=alert(1)>','browser_hint':'Edge','notes':''},a);self.p.locator('#refreshAccounts').click();self.p.wait_for_function("() => document.querySelector('#accountCards').textContent.includes('<img')");self.assertEqual(self.p.locator('#accountCards img').count(),0)
        for width in [1480,390]:
            self.p.set_viewport_size({'width':width,'height':1100});self.assertTrue(self.p.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));self.p.screenshot(path=str(OUT/f'accounts-{width}.png'),full_page=True)
    def test_active_unknown_reply_cannot_start_other_edit(self):
        self.p.locator('#editAccount').click();self.p.locator('#accountName').fill('pending');held=[];self.p.route('**/api/accounts/command',lambda route:held.append(route));self.p.locator('#saveAccount').click();self.p.wait_for_timeout(80);self.p.locator('#closeAccountEditor').click()
        try:self.assertTrue(self.p.locator('#newAccount').is_disabled())
        finally:
            for route in held:route.continue_()
            self.p.unroute('**/api/accounts/command')
    def test_archived_profile_binding_button_stays_disabled_after_refresh(self):
        self.p.locator('#archiveAccount').click();self.p.locator('#accountActionReason').fill('archive test');self.p.locator('#accountActionGo').click();self.p.wait_for_function("() => !document.querySelector('#accountAction').open");self.p.wait_for_function("() => document.querySelector('#archiveAccount').textContent==='恢复记录'");self.p.wait_for_timeout(200);self.assertTrue(self.p.locator('#openBinding').is_disabled())
    def test_health_fetch_failure_does_not_leave_old_green_card(self):
        self.p.route('**/api/accounts/dashboard?*',lambda route:route.fulfill(status=503,content_type='application/json',body=json.dumps({'success':False,'message':'fixture health read unavailable'})))
        self.p.locator('#refreshAccounts').click();self.p.wait_for_function("() => document.querySelector('#ingressFacts').textContent.includes('观察失败')");self.p.wait_for_timeout(100);self.assertNotIn('云端轮询正常',self.p.locator('#accountCards').inner_text())
if __name__=='__main__':unittest.main(verbosity=2)
