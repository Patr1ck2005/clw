"""Real Edge controls for explicit native message policy; no actual Host/model."""
from pathlib import Path
import json,os,sys,threading,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright,expect
from serve_control_center import create_server
import test_routing as fixture
OUT=Path(os.environ.get('CLW_ROUTING_EVIDENCE_DIR',str(ROOT/'evidence/WB002-6/G2/routing-screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-6/G2').resolve()):raise ValueError('output outside scope')

class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.f=fixture.RoutingCase();self.f.setUp();self.store=self.f.store;self.server=create_server(task_store=self.store)
        self.server.routing_engine.stop()  # This fixture controls the router separately; browser must not send automatically.
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
        self.context=self.browser.new_context(viewport={'width':1480,'height':1080});self.page=self.context.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.goto(self.origin+'/tasks.html');expect(self.page.locator('#taskStoreState')).to_contain_text('已连接');self.page.locator('#taskActor').fill('B-declared-fixture')
    def tearDown(self):self.context.close();self.server.shutdown();self.server.server_close();self.thread.join();self.f.tearDown();self.assertEqual(self.errors,[])
    def select(self,t):
        self.page.locator('#refreshTasks').click();self.page.locator(f'[data-task-id="{t["id"]}"]').click();expect(self.page.locator('#taskDetail h2')).to_have_text(t['contract']['title']);self.page.locator('#routingPanel summary').first.click()
    def open(self,name):self.page.locator('#routingPanel').get_by_role('button',name=name,exact=True).click();expect(self.page.locator('#routingDialog')).to_be_visible()
    def test_policy_requires_local_confirmation_not_opening_page(self):
        t=self.f.setup_task(enable=False);self.select(t);self.assertEqual(self.f.bridge.calls,[]);self.open('启用任务通知')
        self.page.locator('#saveRouting').click();self.assertFalse(self.store.get(t['id'])['routing']['enabled'])
        self.page.locator('#routingFields [name=confirm]').check();self.page.locator('#saveRouting').click();expect(self.page.locator('#routingDialog')).not_to_be_visible();self.assertTrue(self.store.get(t['id'])['routing']['enabled']);self.assertEqual(self.f.bridge.calls,[])
    def test_native_binding_checked_and_wrong_generation_preserves_form(self):
        t=self.f.setup_task(bind=False,enable=False);self.select(t);self.open('绑定原生收件目标')
        for name,value in [('agent_id','agent-test'),('conversation_id','conversation-fixture'),('controller_generation','2')]:self.page.locator(f'#routingFields [name={name}]').fill(value)
        self.page.locator('#saveRouting').click();expect(self.page.locator('#routingError')).to_contain_text('mismatch');self.assertEqual(self.page.locator('#routingFields [name=agent_id]').input_value(),'agent-test')
        self.page.locator('#routingFields [name=controller_generation]').fill('1');self.page.locator('#saveRouting').click();expect(self.page.locator('#routingDialog')).not_to_be_visible()
        self.assertEqual(self.store.get(t['id'])['routing']['routes']['coordinator']['agent_id'],'agent-test')
    def test_readonly_native_connection_cannot_enable_from_ui(self):
        t=self.f.setup_task(enable=False);self.f.bridge.enabled=False;self.select(t);self.open('启用任务通知');self.page.locator('#routingFields [name=confirm]').check();self.page.locator('#saveRouting').click()
        expect(self.page.locator('#routingError')).to_contain_text('只读连接');self.assertFalse(self.store.get(t['id'])['routing']['enabled'])
    def test_unknown_notice_retry_keeps_same_key_and_requires_confirmation(self):
        t=self.f.setup_task(ids=('A',));self.f.bridge.fail_after_accept=True;self.f.engine.step();original=self.f.outbox(t)[0];self.select(t);self.open('重试同一原通知')
        self.page.locator('#routingFields [name=reason]').fill('original native idempotency is confirmed');self.page.locator('#saveRouting').click();self.assertEqual(self.f.outbox(t)[0]['phase'],'delivery_unknown')
        self.page.locator('#routingFields [name=confirm]').check();self.page.locator('#saveRouting').click();expect(self.page.locator('#routingDialog')).not_to_be_visible()
        after=self.f.outbox(t)[0];self.assertEqual(after['native_request'],original['native_request']);self.assertEqual(after['phase'],'pending');self.assertEqual(len(self.f.bridge.calls),1)
    def test_disable_preserves_original_unknown_outcome(self):
        t=self.f.setup_task(ids=('A',));self.f.bridge.fail_after_accept=True;self.f.engine.step();self.select(t);self.open('停止新通知');self.page.locator('#routingFields [name=reason]').fill('user pause delivery');self.page.locator('#saveRouting').click();expect(self.page.locator('#routingDialog')).not_to_be_visible()
        after=self.store.get(t['id']);self.assertFalse(after['routing']['enabled']);self.assertEqual(after['routing']['outbox'][0]['phase'],'delivery_unknown')
    def test_binding_and_outcomes_readable_at_wide_and_narrow_viewports(self):
        t=self.f.setup_task();self.f.engine.step();self.select(t)
        for width in (1480,390):
            self.page.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            self.page.screenshot(path=str(OUT/f'routing-{width}.png'),full_page=True)

if __name__=='__main__':unittest.main(verbosity=2)
