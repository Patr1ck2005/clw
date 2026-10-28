"""Actual isolated browser checks for startup identity; no logged-in browser profiles."""
from pathlib import Path
import json,os,sys,threading,unittest
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from serve_control_center import create_server
EVIDENCE=Path(os.environ.get('CLW_RELEASE_EVIDENCE_DIR',str(ROOT/'evidence/WB002-6/G0/browser'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')))).resolve()
if not EVIDENCE.is_relative_to((ROOT/'evidence/WB002-6').resolve()):raise ValueError('evidence outside product test scope')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=create_server();cls.url=f'http://127.0.0.1:{cls.server.server_address[1]}/';cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);EVIDENCE.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def setUp(self):
        self.context=self.browser.new_context(viewport={'width':1480,'height':1000});self.page=self.context.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
    def tearDown(self):self.assertEqual(self.errors,[]);self.context.close()
    def open(self,page=''):
        self.page.goto(self.url+page);expect(self.page.locator('#productStatus')).to_have_attribute('data-state','observed')
    def test_all_pages_have_same_process_identity(self):
        for page in ['','tasks.html','accounts.html','specialists.html','assets.html']:
            self.open(page);self.assertIn('测试进程',self.page.locator('#productStatus strong').inner_text())
            self.assertEqual(self.page.request.get(self.url+'api/product/info').json()['instance_id'],self.server.product_identity.base['instance_id'])
    def test_404_is_unknown_not_old_green(self):
        self.open();self.page.route('**/api/product/info',lambda route:route.fulfill(status=404,body='not found'))
        self.page.locator('#productStatus button').click();expect(self.page.locator('#productStatus')).to_have_attribute('data-state','unknown')
        self.assertIn('旧进程',self.page.locator('#productStatus').inner_text())
    def test_refresh_preserves_pending_task_packet(self):
        self.open();self.page.locator('[data-view=routing]').click();self.page.locator('#goal').fill('保留未发出的完整目标')
        self.page.locator('#productStatus button').click();self.assertEqual(self.page.locator('#goal').input_value(),'保留未发出的完整目标')
    def test_process_change_warns_without_auto_reload(self):
        self.open();value={'success':True,**self.server.product_identity.info()};value['instance_id']='e'*32
        self.page.route('**/api/product/info',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(value)))
        self.page.locator('#productStatus button').click();expect(self.page.locator('#productStatus')).to_have_attribute('data-state','changed')
        self.assertIn('不自动重发',self.page.locator('#productStatus').inner_text())
    def test_wide_narrow_identity_readable_without_overflow(self):
        self.open();self.page.locator('#productStatus summary').click()
        for width in (1480,390):
            self.page.set_viewport_size({'width':width,'height':1000});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            self.page.screenshot(path=str(EVIDENCE/f'runtime-identity-{width}.png'),full_page=True)
if __name__=='__main__':unittest.main(verbosity=2)
