"""Isolated real Edge collaboration UI; claims only program and browser evidence."""
from pathlib import Path
import json
import os
import sys
import tempfile
import threading
import unittest
import uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright, expect
from task_store import TaskStore
from serve_control_center import create_server
from test_task_store import example
from test_collaboration import delivery
OUT=Path(os.environ.get('CLW_COLLAB_EVIDENCE_DIR',str(ROOT/'evidence/WB002-6/G1/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-6/G1').resolve()):raise ValueError('evidence outside scope')


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=TaskStore(Path(self.temp.name)/'tasks.sqlite3');self.server=create_server(task_store=self.store)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
        self.context=self.browser.new_context(viewport={'width':1480,'height':1080},accept_downloads=True);self.p=self.context.new_page();self.errors=[];self.requests=[]
        self.p.on('pageerror',lambda e:self.errors.append(str(e)));self.p.on('request',lambda r:self.requests.append(r.url));self.p.goto(self.origin+'/tasks.html')
        expect(self.p.locator('#taskStoreState')).to_contain_text('已连接');self.p.locator('#taskActor').fill('B用户声明的测试主控')
    def tearDown(self):
        self.context.close();self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
        self.assertEqual(self.errors,[]);self.assertTrue(all(x.startswith(self.origin) or x.startswith('blob:') for x in self.requests))
    def cmd(self,action,t=None,data=None):
        raw={'action':action,'request_id':str(uuid.uuid4()),'actor':'fixture','data':data or {}}
        if t:raw.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(raw)['task']
    def seed(self,enabled=True,claimed=True):
        t=self.cmd('create',data={'contract':example(ids=('A','B'))})
        if enabled:t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        t=self.cmd('publish',t)
        if claimed:
            for rid in ('A','B'):t=self.cmd('claim',t,{'role_id':rid,'external_ref':'fixture-'+rid})
        self.p.locator('#refreshTasks').click();self.p.locator(f'[data-task-id="{t["id"]}"]').click();expect(self.p.locator('#taskDetail h2')).to_have_text(t['contract']['title'])
        return t
    def action(self,label,rid=None):
        container=self.p.locator(f'[data-role-id="{rid}"]') if rid else self.p
        container.get_by_role('button',name=label,exact=True).click();expect(self.p.locator('#taskAction')).to_be_visible()
    def save(self):self.p.locator('#saveTaskAction').click();expect(self.p.locator('#taskAction')).not_to_be_visible()
    def submit(self,t,rid='A'):return self.cmd('deliver',t,delivery(self.store.assignment(t['id'],rid)))
    def refresh(self):self.p.locator('#refreshTasks').click()
    def test_enabling_is_explicit_and_warns_about_old_versions(self):
        t=self.seed(False,False);self.action('启用结构化协作');expect(self.p.locator('#actionFields')).to_contain_text('旧G0不能再打开')
        self.p.locator('#saveTaskAction').click();self.assertNotIn('collaboration',self.store.get(t['id']))
        self.p.locator('[name=confirm_schema_upgrade]').check();self.save();expect(self.p.locator('#taskDetail')).to_contain_text('结构化协作已启用')
    def test_inbox_collects_worker_receipt_without_manual_report_paste(self):
        t=self.seed();self.submit(t)
        expect(self.p.locator('#inboxRows')).to_contain_text('交付待审',timeout=12000)
        expect(self.p.locator('[data-role-id=A]')).to_contain_text('结构化交付与文件哈希')
        self.assertEqual(self.store.get(t['id'])['status'],'open')
    def test_review_rework_requires_independent_evidence(self):
        t=self.submit(self.seed());self.refresh();self.action('审阅结构化交付','A');self.p.locator('[name=outcome]').select_option('rework');self.p.locator('[name=note]').fill('需要补充错误恢复')
        self.p.locator('#saveTaskAction').click();self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'submitted')
        self.p.locator('[name=evidence]').fill('独立对照测试日志');self.save();self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'pending')
        expect(self.p.locator('[data-role-id=A]')).to_contain_text('需要补充错误恢复')
    def test_feedback_draft_survives_sibling_delivery_and_version_conflict(self):
        t=self.seed();self.action('登记中途意见','A');self.p.locator('[name=note]').fill('不能丢弃的局部草稿')
        self.submit(t,'B');self.p.wait_for_timeout(5500);self.assertEqual(self.p.locator('[name=note]').input_value(),'不能丢弃的局部草稿')
        self.p.locator('#saveTaskAction').click();expect(self.p.locator('#actionError')).to_contain_text('其他窗口');self.assertEqual(self.p.locator('[name=note]').input_value(),'不能丢弃的局部草稿')
        self.assertEqual(self.store.get(t['id'])['roles']['B']['status'],'submitted')
        self.p.locator('#rebaseTaskAction').click();expect(self.p.locator('#actionError')).to_contain_text('没有自动重发')
        self.assertEqual(self.p.locator('[name=note]').input_value(),'不能丢弃的局部草稿');self.assertNotIn('feedback',self.store.get(t['id'])['roles']['A'])
        self.save();self.assertEqual(self.store.get(t['id'])['roles']['A']['feedback'][0]['note'],'不能丢弃的局部草稿')
    def test_local_feedback_has_version_and_assignment_packet_includes_it(self):
        t=self.seed();self.action('登记中途意见','A');self.p.locator('[name=note]').fill('按钮尺寸按新要求');self.save()
        expect(self.p.locator('[data-role-id=A]')).to_contain_text('本角色版本 1')
        with self.p.expect_download() as info:self.p.locator('[data-role-id=A]').get_by_role('button',name='导出当前职责包').click()
        packet=json.loads(Path(info.value.path()).read_text(encoding='utf-8'));self.assertEqual(packet['feedback_revision'],1);self.assertEqual(packet['contract']['goal'],t['contract']['goal']);self.assertIn('按钮尺寸',packet['feedback'][0]['note']);self.assertFalse(packet['dispatch_performed'])
        self.assertEqual(self.p.get_by_role('button',name='提交交接',exact=True).count(),0)
    def test_shared_feedback_blocks_simple_resume_and_retains_writers(self):
        t=self.seed();self.action('登记中途意见','A');self.p.locator('[name=scope]').select_option('shared');self.p.locator('[name=note]').fill('公共输入格式变化');self.save()
        expect(self.p.locator('#taskDetail')).to_contain_text('存在共同变更');self.assertEqual(self.p.get_by_role('button',name='恢复协调',exact=True).count(),0)
        self.assertEqual(self.store.get(t['id'])['roles']['B']['status'],'running');expect(self.p.locator('#inboxRows')).to_contain_text('共同变更')
    def test_review_on_stale_delivery_rejected_with_draft_preserved(self):
        t=self.submit(self.seed());self.refresh();self.action('审阅结构化交付','A');self.p.locator('[name=note]').fill('旧结果审阅意见');self.p.locator('[name=evidence]').fill('旧文件核验')
        self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'新要求尚未完成'});self.p.locator('#saveTaskAction').click()
        expect(self.p.locator('#actionError')).to_contain_text('其他窗口');self.assertEqual(self.p.locator('[name=note]').input_value(),'旧结果审阅意见');self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'pending')
        self.p.locator('#rebaseTaskAction').click();expect(self.p.locator('#actionError')).to_contain_text('不能用旧审阅批准新成果');self.assertEqual(self.p.locator('[name=note]').input_value(),'旧结果审阅意见')
    def test_markup_in_worker_summary_is_only_text(self):
        t=self.seed();data=delivery(self.store.assignment(t['id'],'A'));data['summary']='<img src=x onerror=alert(1)>';self.cmd('deliver',t,data);self.p.locator('#refreshInbox').click()
        expect(self.p.locator('#inboxRows')).to_contain_text('<img');self.assertEqual(self.p.locator('#inboxRows img').count(),0)
    def test_inbox_and_delivery_readable_at_two_viewports(self):
        t=self.seed();t=self.submit(t,'A');self.submit(t,'B');self.refresh();self.p.locator('#refreshInbox').click();expect(self.p.locator('#inboxRows')).to_contain_text('交付待审')
        for width in (1480,390):
            self.p.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            self.p.screenshot(path=str(OUT/f'collaboration-{width}.png'),full_page=True)

if __name__=='__main__':unittest.main(verbosity=2)
