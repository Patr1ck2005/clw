"""Actual Edge Goal controls; data/program fixtures are not real model acceptance."""
from pathlib import Path
import json
import os
import sys
import threading
import unittest
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright, expect
from serve_control_center import create_server
import test_goals as fixture
from test_task_store import example
OUT=Path(os.environ.get('CLW_GOAL_EVIDENCE_DIR',str(ROOT/'evidence/WB002-6/G3/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-6/G3').resolve()):raise ValueError('evidence outside scope')

class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.f=fixture.GoalTests(methodName='runTest');self.f.setUp();self.store=self.f.store
        self.server=create_server(task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_address[1]}';self.context=self.browser.new_context(viewport={'width':1480,'height':1080},accept_downloads=True);self.page=self.context.new_page();self.errors=[];self.requests=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.on('request',lambda r:self.requests.append(r.url));self.page.goto(self.origin+'/tasks.html')
        expect(self.page.locator('#taskStoreState')).to_contain_text('已连接');self.page.locator('#taskActor').fill('B-declared-goal-review')
    def tearDown(self):
        self.context.close();self.server.shutdown();self.server.server_close();self.thread.join();self.f.tearDown()
        self.assertEqual(self.errors,[]);self.assertTrue(all(x.startswith(self.origin) or x.startswith('blob:') for x in self.requests))
    def select(self,t):
        self.page.locator('#refreshTasks').click();self.page.locator(f'[data-task-id="{t["id"]}"]').click();expect(self.page.locator('#taskDetail h2')).to_have_text(t['contract']['title'])
    def open(self,name):self.page.locator('#goalPanel').get_by_role('button',name=name,exact=True).click();expect(self.page.locator('#goalDialog')).to_be_visible()
    def save(self):self.page.locator('#saveGoal').click();expect(self.page.locator('#goalDialog')).not_to_be_visible()
    def test_enable_requires_explicit_confirmation(self):
        t=self.f.cmd('create',data={'contract':example()});t=self.f.cmd('collaborate',t,{'confirm_schema_upgrade':True});t=self.f.cmd('publish',t);self.select(t);self.open('启用持续目标')
        self.page.locator('#saveGoal').click();self.assertNotIn('goal',self.store.get(t['id']))
        self.page.locator('#goalFields [name=confirm_schema_upgrade]').check();self.save();expect(self.page.locator('#goalPanel')).to_contain_text('第 1 轮')
        self.assertEqual(self.store.get(t['id'])['roles']['A']['status'],'pending')
    def test_checkpoint_contains_evidence_without_advancing(self):
        t=self.f.goal();self.select(t);self.open('保存目标恢复点')
        for name,value in [('completed','已核对源文件'),('remaining','原目标尚未完成'),('next_step','独立实现'),('evidence','reports/input.md')]:self.page.locator(f'#goalFields [name={name}]').fill(value)
        self.save();state=self.store.get(t['id']);self.assertEqual(state['goal']['cycle'],1);self.assertEqual(state['goal']['checkpoint']['evidence'],['reports/input.md'])
    def test_next_cycle_same_task_and_no_implicit_resume(self):
        t=self.f.cycle(self.f.goal());t=self.f.cmd('pause',t,{'reason':'explicit user pause'});self.select(t);self.open('安排下一轮计划');self.save()
        state=self.store.get(t['id']);self.assertEqual(state['status'],'paused');self.assertEqual(state['goal']['cycle'],2);self.assertTrue(all(s['status']=='pending' and s['binding'] is None for s in state['roles'].values()))
        expect(self.page.locator('#goalPanel')).to_contain_text('第 2 轮')
    def test_scope_expansion_rejected_and_draft_preserved(self):
        t=self.f.cycle(self.f.goal(ids=('A',)));self.select(t);self.open('安排下一轮计划')
        roles=t['contract']['roles'];roles[0]['scopes']=['.'];draft=json.dumps(roles,ensure_ascii=False);self.page.locator('#goalFields [name=roles]').fill(draft);self.page.locator('#saveGoal').click()
        expect(self.page.locator('#goalError')).to_contain_text('原授权');self.assertEqual(self.page.locator('#goalFields [name=roles]').input_value(),draft);self.assertEqual(self.store.get(t['id'])['goal']['cycle'],1)
    def test_conflicting_new_feedback_does_not_overwrite_plan_draft(self):
        t=self.f.cycle(self.f.goal());self.select(t);self.open('安排下一轮计划');draft=self.page.locator('#goalFields [name=roles]').input_value()
        self.f.cmd('feedback',t,{'role_id':'A','scope':'local','note':'new user requirement'});self.page.locator('#saveGoal').click()
        expect(self.page.locator('#goalError')).to_contain_text('其他窗口');self.assertEqual(self.page.locator('#goalFields [name=roles]').input_value(),draft)
        self.assertEqual(self.store.get(t['id'])['goal']['cycle'],1)
    def test_budget_warning_prevents_next_cycle_button(self):
        t=self.f.cycle(self.f.goal(failure_limit=1),'failed_route',True);self.select(t)
        expect(self.page.locator('#goalPanel')).to_contain_text('已达循环');self.assertEqual(self.page.locator('#goalPanel').get_by_role('button',name='安排下一轮计划',exact=True).count(),0)
        self.open('调整循环授权');self.page.locator('#goalFields [name=failure_limit]').fill('3');self.page.locator('#goalFields [name=reason]').fill('explicit further review authorized');self.page.locator('#goalFields [name=confirm]').check();self.save()
        self.assertEqual(self.store.get(t['id'])['goal']['failure_limit'],3)
    def test_common_change_can_replan_only_after_stopping_and_keeps_pause(self):
        t=self.f.goal(ids=('A',));t=self.f.cmd('feedback',t,{'role_id':'A','scope':'shared','note':'common input changed'});self.select(t);self.open('处理共同变更')
        self.page.locator('#goalFields [name=reason]').fill('new plan incorporates common input');self.page.locator('#goalFields [name=evidence]').fill('reports/stopped.md');self.page.locator('#goalFields [name=confirm]').check();self.save()
        after=self.store.get(t['id']);self.assertEqual(after['status'],'paused');self.assertEqual(after['goal']['cycle'],2);self.assertIsNone(after['acceptance_review'])
        self.assertEqual(after['goal']['last_cycle']['outcome'],'interrupted_by_shared_change_not_completed')

    def test_goal_export_and_responsive_layout(self):
        t=self.f.cycle(self.f.goal());self.select(t)
        with self.page.expect_download() as download:self.page.get_by_role('button',name='导出完整任务包',exact=True).click()
        text=Path(download.value.path()).read_text(encoding='utf-8');self.assertIn('持续原目标，不按时间拆轮',text);self.assertIn(t['goal']['intent_hash'],text)
        for width in (1480,390):
            self.page.set_viewport_size({'width':width,'height':1080});self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
            self.page.screenshot(path=str(OUT/f'goal-{width}.png'),full_page=True)

if __name__=='__main__':unittest.main(verbosity=2)
