"""Real isolated Edge; synthetic no-model provider. No real accounts/credentials touched."""
from pathlib import Path
import json,os,sys,tempfile,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright
from task_store import TaskStore
from usage_store import UsageStore
from specialist_service import Specialists
from specialist_fixture import FakeNative
from test_task_store import Observe,example
from test_usage_store import sample
from serve_control_center import create_server
OUT=Path(os.environ.get('CLW_SPECIALIST_EVIDENCE_DIR',str(ROOT/'evidence/WB002-4/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-4').resolve()):raise ValueError('Evidence must remain scoped')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.tasks=TaskStore(Path(self.tmp.name)/'tasks.sqlite3',Observe());self.usage=UsageStore(Path(self.tmp.name)/'usage.sqlite3');self.bridge=FakeNative();self.svc=Specialists(self.tasks,self.bridge)
        self.server=create_server(0,task_store=self.tasks,specialists=self.svc,usage_store=self.usage);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}/'
        self.ctx=self.browser.new_context(viewport={'width':1480,'height':1080});self.p=self.ctx.new_page();self.errors=[];self.network=[];self.p.on('pageerror',lambda e:self.errors.append(str(e)));self.p.on('request',lambda r:self.network.append(r.url));self.goto()
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.assertTrue(all(u.startswith(self.url) or u.startswith('blob:') for u in self.network));self.ctx.close();self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def goto(self):
        self.p.goto(self.url+'specialists.html');self.p.wait_for_function("() => document.querySelectorAll('.ledger-card').length===3");self.p.locator('#specialistActor').fill('界面测试操作者')
    def seed(self):
        c=example('codex');c['roles'][0]['scopes']=['.'];t=None
        for action,data in [('create',{'contract':c}),('publish',{}),('claim',{'role_id':'A','external_ref':'test-only'})]:
            r={'request_id':str(uuid.uuid4()),'action':action,'actor':'test','data':data}
            if t:r.update(task_id=t['id'],expected_version=t['version'])
            t=self.tasks.command(r)['task']
        self.p.locator('#refreshSpecialists').click();self.p.locator('#specialistTask').select_option(t['id']);self.p.wait_for_function("() => document.querySelector('#roleScope').textContent.includes('running')");return t
    def prepare(self):
        t=self.seed();p=self.p;p.locator('#discoverProvider').click();p.wait_for_function("() => document.querySelector('#nativeProvider').value==='codex'")
        for id,value in [('nativeAccount','test alias'),('nativeModel','requested-model'),('nativeEffort','high'),('nativeMode','agent')]:p.locator('#'+id).fill(value)
        p.locator('#prepareNative').click();p.wait_for_function("() => document.querySelector('#nativeRun').textContent.includes('专项状态：prepared')");return t
    def start(self):
        self.p.locator('#nativeStart').click();self.p.locator('#nativeConsent').check();self.p.locator('#nativeConfirmGo').click();self.p.wait_for_function("() => !document.querySelector('#nativeConfirm').open")
    def usage_form(self,**values):
        s=sample(**values);mapping={'bucket':'usageBucket','account_alias':'usageAccount','kind':'usageKind','unit':'usageUnit','amount':'usageAmount','source':'usageSource','reference':'usageReference','window':'usageWindow','observed_at':'usageObserved','resets_at':'usageReset','task_id':'usageTask','note':'usageNote','status':'usageStatus'}
        for key,id in mapping.items():
            if key in {'bucket','kind','source','status'}:self.p.locator('#'+id).select_option(s[key])
            else:self.p.locator('#'+id).fill(s[key] or '')
    def test_opening_never_dispatches_and_three_ledgers_unknown(self):self.assertEqual(self.bridge.calls,[]);self.assertEqual(self.p.locator('.ledger-card strong').all_text_contents(),['官方余量未知']*3)
    def test_prepare_confirm_observe_handoff_boundary(self):
        t=self.prepare();self.assertEqual(self.bridge.calls,[]);self.p.locator('#nativeStart').click();self.p.locator('#nativeConfirmClose').click();self.assertEqual(self.bridge.calls,[]);self.start();self.assertEqual(len(self.bridge.runs),1)
        self.bridge.mode='completed';self.bridge.execution='completed';self.p.locator('#nativeObserve').click();self.p.wait_for_function("() => document.querySelector('#nativeRun').textContent.includes('专项状态：completed')");self.assertEqual(self.tasks.get(t['id'])['status'],'open');self.assertEqual(self.tasks.get(t['id'])['roles']['A']['status'],'running')
    def test_lost_browser_reply_recovers_without_second_run(self):
        t=self.prepare()
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/specialists/command',lose);self.p.locator('#nativeStart').click();self.p.locator('#nativeConsent').check();self.p.locator('#nativeConfirmGo').click();self.p.wait_for_function("() => document.querySelector('#nativeConfirmError').textContent.includes('结果未知')");self.assertEqual(len(self.bridge.runs),1)
        self.p.unroute('**/api/specialists/command',lose);self.goto();self.p.locator('#reconcileSpecialist').click();self.p.wait_for_function("() => document.querySelector('#pendingSpecialist').hidden");self.assertEqual(len(self.bridge.calls),1)
    def test_unknown_native_result_survives_reload_and_recovers_same_key(self):
        t=self.prepare();self.bridge.lose_once=True;self.start();self.assertIn('unknown',self.p.locator('#nativeRun').inner_text());self.goto();self.p.locator('#specialistTask').select_option(t['id']);self.p.wait_for_function("() => !document.querySelector('#nativeRetry').disabled");self.p.locator('#nativeRetry').click();self.p.locator('#nativeConsent').check();self.p.locator('#nativeConfirmGo').click();self.p.wait_for_function("() => !document.querySelector('#nativeConfirm').open");self.assertEqual(len(self.bridge.runs),1)
    def test_no_provider_disables_prepare_without_install(self):
        self.bridge.provider=False;self.seed();self.p.locator('#discoverProvider').click();self.p.wait_for_function("() => document.querySelector('#providerNotice').textContent.length>0");self.assertTrue(self.p.locator('#prepareNative').is_disabled());self.assertEqual(self.bridge.calls,[])
    def test_unknown_bill_corrected_preserves_original_id_and_history(self):
        self.usage_form(amount=None,status='unknown');self.p.locator('#saveUsage').click();self.p.wait_for_function("() => document.querySelectorAll('.ledger-record').length===1");record=self.usage.listing()['entries'][0]
        self.p.get_by_role('button',name='修正原记录',exact=True).click();self.p.locator('#usageStatus').select_option('known');self.p.locator('#usageAmount').fill('0.30');self.p.locator('#usageNote').fill('final invoice checked');self.p.locator('#saveUsage').click();self.p.wait_for_function("() => document.querySelector('#usageEntries').textContent.includes('v2')");self.assertEqual(self.usage.listing()['entries'][0]['id'],record['id']);self.assertEqual(len(self.usage.history(record['id'])['records']),2)
    def test_lost_bill_reply_reconciles_without_duplicate_record(self):
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/usage/command',lose);self.usage_form();self.p.locator('#saveUsage').click();self.p.wait_for_function("() => document.querySelector('#specialistNotice').textContent.includes('结果未知')");self.p.unroute('**/api/usage/command',lose);self.goto();self.p.locator('#reconcileUsage').click();self.p.wait_for_function("() => document.querySelector('#pendingUsage').hidden");self.assertEqual(len(self.usage.listing()['entries']),1)
    def test_markup_stays_text_and_narrow_layout(self):
        self.usage.command({'request_id':str(uuid.uuid4()),'action':'record','actor':'test','data':sample(note='<img src=x onerror=alert(1)>')});self.p.locator('#refreshUsage').click();self.p.wait_for_function("() => document.querySelectorAll('.ledger-record').length===1");self.assertEqual(self.p.locator('#usageEntries img').count(),0)
        for width in (1480,390):self.p.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.p.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));self.p.screenshot(path=str(OUT/f'specialists-{width}.png'),full_page=True)
    def test_real_dialog_screenshot_has_exact_request(self):
        self.prepare();self.p.locator('#nativeStart').click();self.assertIn('requested-model',self.p.locator('#nativeConfirmText').inner_text());self.p.screenshot(path=str(OUT/'specialist-confirm.png'),full_page=True)
    def test_changing_task_immediately_clears_old_run_actions(self):
        first=self.prepare()
        second=self.tasks.command({'request_id':str(uuid.uuid4()),'action':'create','actor':'tester','data':{'contract':example('codex')}})['task']
        self.p.locator('#refreshSpecialists').click();self.p.wait_for_function("() => document.querySelector('#nativeStart').disabled===false")
        held=[]
        pattern='**/api/tasks/get?id='+second['id']
        self.p.route(pattern,lambda route:held.append(route))
        self.p.locator('#specialistTask').select_option(second['id']);self.p.wait_for_timeout(100)
        try:
            self.assertTrue(self.p.locator('#nativeStart').is_disabled())
            self.assertNotIn(first['contract']['title'],self.p.locator('#roleScope').inner_text())
        finally:
            for route in held:route.continue_()
            self.p.unroute(pattern)
    def test_pending_native_dispatch_cannot_open_another_confirmation(self):
        self.prepare();held=[]
        self.p.route('**/api/specialists/command',lambda route:held.append(route))
        self.p.locator('#nativeStart').click();self.p.locator('#nativeConsent').check();self.p.locator('#nativeConfirmGo').click();self.p.wait_for_timeout(100)
        self.p.locator('#nativeConfirmClose').click()
        try:
            self.p.locator('#nativeStart').click()
            self.assertFalse(self.p.locator('#nativeConfirm').evaluate('(d) => d.open'))
        finally:
            for route in held:route.continue_()
            self.p.unroute('**/api/specialists/command')
    def test_prepared_instruction_hash_fits_narrow_view(self):
        self.prepare();self.p.set_viewport_size({'width':390,'height':1080})
        self.p.locator('#nativeRun details').evaluate('(d) => {d.open=true;}')
        self.p.screenshot(path=str(OUT/'prepared-long-metadata-390.png'),full_page=True)
        self.assertTrue(self.p.evaluate('() => document.documentElement.scrollWidth<=innerWidth'))
    def test_actual_download_does_not_claim_complete_backup(self):
        with self.p.expect_download() as d:self.p.locator('#exportUsage').click()
        data=json.loads(Path(d.value.path()).read_text());self.assertIn('current page',data['coverage']);self.assertEqual(data['summary']['official_remaining']['chat'],None)
if __name__=='__main__':unittest.main(verbosity=2)
