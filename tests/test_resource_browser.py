"""Actual isolated Edge controls for resources; does not claim pilot acceptance."""
from pathlib import Path
import json,os,sys,threading,unittest,time
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright,expect
from test_resources import ResourceCase
from serve_control_center import create_server
OUT=Path(os.environ.get('CLW_RESOURCE_EVIDENCE_DIR',str(ROOT/'evidence/WB002-6/G4/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-6/G4').resolve()):raise ValueError('evidence outside scope')

class ResourceBrowserTests(ResourceCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        super().setUp();self.t=self.start();self.server=create_server(task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_address[1]}';self.context=self.browser.new_context(viewport={'width':1480,'height':1080});self.p=self.context.new_page();self.errors=[];self.requests=[]
        self.p.on('pageerror',lambda e:self.errors.append(str(e)));self.p.on('request',lambda r:self.requests.append(r.url));self.p.goto(self.url+'/tasks.html')
        expect(self.p.locator('#taskStoreState')).to_contain_text('已连接');self.p.locator('#taskActor').fill('B declared fixture')
        self.p.locator(f'[data-task-id="{self.t["id"]}"]').click();expect(self.p.locator('#taskDetail h2')).to_have_text(self.t['contract']['title'])
    def tearDown(self):
        self.context.close();self.server.shutdown();self.server.server_close();self.thread.join();super().tearDown()
        self.assertEqual(self.errors,[]);self.assertTrue(all(x.startswith(self.url) or x.startswith('blob:') for x in self.requests))
    def setup_resource(self,observe=True):
        self.t,self.key=self.define(self.t)
        if observe:self.observe(self.t,self.key)
        self.p.locator('#refreshTasks').click();self.p.locator('#refreshResources').click();expect(self.p.locator('#resourceRows')).to_contain_text('compute')
    def save(self):self.p.locator('#saveResource').click();expect(self.p.locator('#resourceDialog')).not_to_be_visible()
    def test_define_requires_confirmation_and_is_same_task_metadata(self):
        self.p.locator('#defineResource').click();expect(self.p.locator('#resourceDialog')).to_be_visible()
        for name,value in [('namespace','fixture'),('name','review-seat'),('label','Review seat'),('authority_ref','explicit authority')]:self.p.locator(f'#resourceFields [name={name}]').fill(value)
        self.p.locator('#saveResource').click();self.assertEqual(self.store.resources()['resources'],[])
        self.p.locator('[name=confirm_schema_upgrade]').check();self.save();self.assertEqual(self.schema(),'3');expect(self.p.locator('#resourceRows')).to_contain_text('Review seat')
    def test_unobserved_resource_is_not_shown_available(self):
        self.setup_resource(False);expect(self.p.locator('#resourceRows')).to_contain_text('来源观测缺失或已过期')
        self.assertEqual(self.store.resources()['resources'][0]['grantable'],0)
    def test_observation_and_request_keep_execution_separate(self):
        self.setup_resource(False);self.p.locator('#resourceRows').get_by_role('button',name='登记实际观测').click()
        self.p.locator('[name=availability]').select_option('available');self.p.locator('[name=available_capacity]').fill('1');self.p.locator('#resourceFields [name=evidence]').fill('actual fixture checked');self.save()
        self.p.locator('[data-role-id=A]').get_by_role('button',name='申请整组资源').click();expect(self.p.locator('#resourceDialog')).to_be_visible()
        self.p.locator(f'[name=units_{self.key}]').fill('1');self.p.locator('[name=guard_evidence]').fill('guard checked');self.save()
        self.assertEqual(self.group(self.t)['phase'],'reserved');self.assertIsNone(self.group(self.t)['start_intent'])
        self.p.locator('[data-role-id=A]').get_by_role('button',name='启动前核验入口').click();expect(self.p.locator('#resourceFields')).to_contain_text('task_resource_worker.py');self.assertTrue(self.p.locator('#saveResource').is_hidden())
    def test_unknown_execution_not_released_by_ui(self):
        self.setup_resource();self.request(self.t,'A',[self.key]);self.begin(self.t);self.p.locator('#refreshTasks').click()
        self.p.locator('[data-role-id=A]').get_by_role('button',name='执行结果未知').click();self.p.locator('#resourceFields [name=reason]').fill('original response missing');self.save()
        self.assertEqual(self.group(self.t)['phase'],'unknown');self.assertEqual(self.store.resources()['resources'][0]['occupied'],1)
        self.assertEqual(self.p.locator('[data-role-id=A]').get_by_role('button',name='取消未开始申请').count(),0)
    def test_version_conflict_keeps_draft_and_never_silently_retries(self):
        self.setup_resource();self.p.locator('#resourceRows').get_by_role('button',name='登记实际观测').click();self.p.locator('#resourceFields [name=evidence]').fill('unlost draft')
        self.cmd('feedback',self.latest(self.t),{'role_id':'B','scope':'local','note':'sibling change'})
        self.p.locator('#saveResource').click();expect(self.p.locator('#resourceError')).to_contain_text('其他窗口');self.assertEqual(self.p.locator('#resourceFields [name=evidence]').input_value(),'unlost draft')
        self.assertEqual(self.store.resources()['resources'][0]['observation']['availability'],'available')
    def test_failed_refresh_marks_existing_resource_snapshot_unknown(self):
        self.setup_resource();self.p.route('**/api/tasks/resources*',lambda r:r.fulfill(status=503,content_type='application/json',body='{"success":false,"message":"fixture offline"}'))
        self.p.locator('#refreshResources').click();expect(self.p.locator('#resourceRows')).to_have_attribute('data-state','unknown');expect(self.p.locator('#resourceNotice')).to_contain_text('旧记录')
        self.assertTrue(self.p.locator('#resourceRows button').is_disabled())
    def test_resource_dialog_draft_untouched_by_polling(self):
        self.setup_resource();self.p.locator('#resourceRows').get_by_role('button',name='登记实际观测').click();self.p.locator('#resourceFields [name=evidence]').fill('draft waiting for user')
        self.p.wait_for_timeout(5200);self.assertEqual(self.p.locator('#resourceFields [name=evidence]').input_value(),'draft waiting for user');self.assertEqual(self.group_count(),0)
    def group_count(self):return sum('resource_request' in s for s in self.latest(self.t)['roles'].values())
    def test_actual_wide_and_narrow_resource_layout(self):
        self.setup_resource();self.request(self.t,'A',[self.key]);self.p.locator('#refreshTasks').click();self.p.locator('#refreshResources').click();expect(self.p.locator('#resourceRows')).to_contain_text('窗口已保留')
        for width in (1480,390):
            self.p.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            self.p.screenshot(path=str(OUT/f'resources-{width}.png'),full_page=True)

if __name__=='__main__':unittest.main(verbosity=2)
