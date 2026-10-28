"""Real Edge task UI against an isolated product DB and synthetic read-only runtime."""
from pathlib import Path
import json,os,sys,tempfile,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'tests'))
from task_store import TaskStore
from live_observer import Observer
from live_transport import Transport
from live_fixture import Fixture,TOKEN,P1,S1
from serve_control_center import create_server
from test_task_store import example
from playwright.sync_api import sync_playwright
OUT=Path(os.environ.get('CLW_TASK_EVIDENCE_DIR',str(ROOT/'evidence/WB002-3/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-3').resolve()):raise ValueError('Task evidence must remain scoped')

class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.fixture=Fixture();self.observer=Observer(Transport(self.fixture.origin,TOKEN),cache_secs=0)
        self.store=TaskStore(Path(self.tmp.name)/'tasks.sqlite3',self.observer);self.server=create_server(0,self.observer,self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}/'
        self.context=self.browser.new_context(viewport={'width':1480,'height':1080},accept_downloads=True);self.p=self.context.new_page();self.errors=[];self.requests=[];self.p.on('pageerror',lambda x:self.errors.append(str(x)));self.p.on('request',lambda r:self.requests.append(r.url));self.goto(self.p)
    def tearDown(self):
        self.assertEqual(self.errors,[]);self.assertTrue(all(u.startswith(self.url) or u.startswith('blob:') for u in self.requests));self.context.close();self.server.shutdown();self.server.server_close();self.thread.join();self.fixture.close();self.tmp.cleanup()
    def goto(self,p):
        p.goto(self.url+'tasks.html');p.wait_for_function("() => document.querySelector('#taskStoreState').textContent.includes('已连接')");p.locator('#taskActor').fill('测试协调者')
    def seed(self,executor='manual',roles=('A',),published=True):
        c=example(executor,roles,path='D:/sandbox/alpha');c['roles'][0]['project_id']=P1
        for r in c['roles']:r['project_id']=P1
        t=self.store.command({'request_id':str(uuid.uuid4()),'action':'create','actor':'seed','data':{'contract':c}})['task']
        if published:t=self.store.command({'request_id':str(uuid.uuid4()),'action':'publish','actor':'seed','data':{},'task_id':t['id'],'expected_version':t['version']})['task']
        self.p.locator('#refreshTasks').click();self.p.locator(f'[data-task-id="{t["id"]}"]').click();self.p.wait_for_function("() => document.querySelectorAll('.task-role').length>0");return t
    def action(self,label,p=None):
        p=p or self.p;p.get_by_role('button',name=label,exact=True).click();p.wait_for_function("() => document.querySelector('#taskAction').open")
    def save(self,p=None):
        p=p or self.p;p.locator('#saveTaskAction').click();p.wait_for_function("() => !document.querySelector('#taskAction').open")
    def test_create_draft_through_ui_and_export_preserves_goal(self):
        p=self.p;p.locator('#newTask').click();p.locator('#editTitle').fill('浏览器真实任务');p.locator('#editGoal').fill('完整目标\n不删第二行');p.locator('#editAcceptance').fill('产生证据\n保持中文');p.locator('.role-editor [name=objective]').fill('完成独立模块');p.locator('.role-editor [name=executor]').select_option('manual');p.locator('.role-editor [name=scopes]').fill('src/new');p.locator('#saveTask').click();p.wait_for_function("() => !document.querySelector('#taskEditor').open");self.assertIn('草稿',p.locator('#taskDetail').inner_text());self.assertEqual(len(self.store.listing()['tasks']),1)
        with p.expect_download() as info:p.get_by_role('button',name='导出完整任务包',exact=True).click()
        self.assertIn('完整目标\n不删第二行',Path(info.value.path()).read_text(encoding='utf-8'))
    def test_full_publish_claim_checkpoint_handoff_review_accept(self):
        t=self.seed(published=False);self.action('发布合同');self.save();self.action('登记开工');self.p.locator('[name=external_ref]').fill('manual-test-reference');self.save()
        self.action('保存恢复点');self.p.locator('[name=completed]').fill('已完成一半');self.p.locator('[name=remaining]').fill('剩余验收');self.p.locator('[name=original_jobs]').fill('exact-original-job');self.save();self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'running')
        self.action('提交交接')
        for key in ['summary','changes','tests','artifacts']:self.p.locator(f'[name={key}]').fill('真实'+key+'证据引用')
        self.p.locator('[name=limitations]').fill('声明尚未真实项目验收');self.p.locator('[name=stopped_writing]').check();self.save();self.assertEqual(self.store.get(t['id'])['status'],'open')
        self.action('审阅交接');self.p.locator('[name=note]').fill('已核对具体成果和日志');self.save();self.action('逐条验收父任务')
        for i in range(2):self.p.locator(f'[name=passed_{i}]').check();self.p.locator(f'[name=evidence_{i}]').fill('验收项对应证据'+str(i))
        self.p.locator('[name=note]').fill('完整目标验收');self.save();self.assertEqual(self.store.get(t['id'])['status'],'accepted')
        self.p.reload();self.p.wait_for_function("() => document.querySelector('#taskStoreState').textContent.includes('已连接')");self.p.locator(f'[data-task-id="{t["id"]}"]').click();self.p.wait_for_function("() => document.querySelector('#taskDetail .task-state')?.textContent==='父任务已验收'");self.assertIn('父任务已验收',self.p.locator('#taskDetail').inner_text())
    def test_actual_observed_session_binding_never_launches(self):
        t=self.seed('web');self.action('核对 / 绑定 Session');self.p.locator('[name=session_choice]').select_option(S1);self.save();self.assertEqual(self.store.get(t['id'])['roles']['A']['binding']['session_id'],S1)
        self.action('登记开工');self.save();self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'running');self.assertTrue(all(r['path'] in ['/api/runtime/status','/api/runtime-console/projects','/api/runtime-console/workflow-sessions','/api/runtime-console/workflow-session','/api/jobs/list'] for r in self.fixture.requests))
    def test_stale_tab_keeps_draft_instead_of_overwrite(self):
        t=self.seed();q=self.context.new_page();self.goto(q);q.locator(f'[data-task-id="{t["id"]}"]').click();q.wait_for_function("() => document.querySelectorAll('.task-role').length>0")
        self.action('暂停协调',q);q.locator('[name=reason]').fill('不可丢弃的旧草稿');self.action('暂停协调');self.p.locator('[name=reason]').fill('首个窗口原因');self.save()
        q.locator('#saveTaskAction').click();q.wait_for_function("() => document.querySelector('#actionError').textContent.includes('其他窗口')");self.assertEqual(q.locator('[name=reason]').input_value(),'不可丢弃的旧草稿');self.assertTrue(q.locator('#taskAction').is_visible());q.close()
    def test_lost_post_response_recovers_original_receipt_on_reload(self):
        t=self.seed()
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/tasks/command',lose);self.action('暂停协调');self.p.locator('[name=reason]').fill('未知结果只查原请求');self.p.locator('#saveTaskAction').click();self.p.wait_for_function("() => document.querySelector('#actionError').textContent.includes('结果未知')")
        self.assertEqual(self.store.get(t['id'])['status'],'paused');self.assertTrue(self.p.locator('#pendingRequest').is_visible());self.p.unroute('**/api/tasks/command',lose)
        self.p.reload();self.p.wait_for_function("() => !document.querySelector('#pendingRequest').hidden");self.p.locator('#reconcileTask').click();self.p.wait_for_function("() => document.querySelector('#pendingRequest').hidden");self.assertEqual([e['action'] for e in self.store.events(t['id'])['events']].count('pause'),1)
    def test_import_strips_forged_passed_status(self):
        t=self.seed();bundle=json.loads(self.store.export(t['id'])['content']);bundle['task']['status']='accepted';bundle['task']['roles']['A']['status']='accepted'
        self.p.locator('#taskImport').set_input_files({'name':'task.json','mimeType':'application/json','buffer':json.dumps(bundle).encode()});self.p.wait_for_function("() => document.querySelectorAll('.task-list-item').length===2");items=self.store.listing()['tasks'];self.assertEqual(items[-1]['status'],'draft')
    def test_bad_import_leaves_existing_tasks(self):
        self.seed();self.p.locator('#taskImport').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'not-json'});self.p.wait_for_function("() => document.querySelector('#taskNotice').textContent.length>0");self.assertEqual(len(self.store.listing()['tasks']),1)
    def test_untrusted_markup_remains_plain_text(self):
        c=example(path='D:/sandbox/alpha');c['title']='<img src=x onerror=alert(1)>';t=self.store.command({'request_id':str(uuid.uuid4()),'action':'create','actor':'M','data':{'contract':c}})['task'];self.p.locator('#refreshTasks').click();self.p.locator(f'[data-task-id="{t["id"]}"]').click();self.p.wait_for_function("() => document.querySelector('#taskDetail h2')?.textContent.startsWith('<img')");self.assertEqual(self.p.locator('#taskDetail img').count(),0)
    def test_parallel_role_setup_and_layout(self):
        t=self.seed(roles=('A','B','C','D'));self.assertEqual(self.p.locator('.task-role').count(),4)
        for width in [1480,390]:
            self.p.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.p.evaluate('document.documentElement.scrollWidth<=innerWidth'));self.p.screenshot(path=str(OUT/f'task-board-{width}.png'),full_page=True)
        self.p.set_viewport_size({'width':1480,'height':1080});self.p.get_by_role('button',name='修订合同（新版本）').click();self.p.screenshot(path=str(OUT/'task-editor.png'),full_page=True)
    def test_visible_board_observes_other_window_changes_without_click(self):
        t=self.seed();self.store.command({'request_id':str(uuid.uuid4()),'action':'pause','actor':'另一窗口','task_id':t['id'],'expected_version':t['version'],'data':{'reason':'共享任务状态变化'}})
        self.p.wait_for_function("() => document.querySelector('#taskDetail .task-state')?.textContent==='协调已暂停'",timeout=12000)
        self.assertEqual(self.store.get(t['id'])['version'],t['version']+1)
    def test_cancelled_editor_never_sends_a_command(self):
        self.p.locator('#newTask').click();self.p.locator('#editTitle').fill('未保存');self.p.locator('#closeTaskEditor').click();self.assertEqual(self.store.listing()['tasks'],[])

if __name__=='__main__':unittest.main(verbosity=2)
