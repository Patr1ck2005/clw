"""Durable task coordination, isolated metadata only. Does not operate any real project."""
from pathlib import Path
from contextlib import closing
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from task_domain import contract,absolute,TaskError,fingerprint
from task_store import TaskStore

P='agent:test:project';SID='wc_sess_example'
def example(executor='manual',ids=('A',),path='D:/sandbox/project'):
    return {'title':'完整中文任务','goal':'保留全部目标\n第二行约束不能丢','constraints':'不改其他项目','baseline':'基线v1','sources':'AGENTS.md','coordinator':'M','mode':'hybrid','acceptance':['测试通过','交接齐全'],
      'roles':[{'id':rid,'name':rid,'objective':rid+'的完整实现','executor':executor,'project_id':P,'project_root':path,'worktree':path,'access':'write','scopes':['src/'+rid],'depends_on':[]} for rid in ids]}
class Observe:
    def __init__(self): self.calls=[];self.connection='wc-live-fixture';self.status='connected';self.project=P;self.path='D:/sandbox/project';self.session=SID
    def state(self,project='',session='',**kwargs):
        self.calls.append((project,session))
        return {'state':self.status,'connection_id':self.connection,'observed_at':'2026-09-20T00:00:00Z','coverage':{'sessions':{'returned':1,'total':1,'truncated':False}},
          'projection':{'projects':[{'id':self.project,'path':self.path}],'sessions':[{'id':self.session,'project_id':self.project,'lifecycle':'active','title':'明确会话'}]}}
class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'tasks.sqlite3';self.observer=Observe();self.store=TaskStore(self.path,self.observer)
    def tearDown(self): self.tmp.cleanup()
    def command(self,action,task=None,data=None,request=None):
        req={'request_id':request or str(uuid.uuid4()),'action':action,'actor':'本机M','data':data or {}}
        if task:req.update(task_id=task['id'],expected_version=task['version'])
        return self.store.command(req)['task']
    def create(self,c=None): return self.command('create',data={'contract':c or example()})
    def opened(self,c=None): return self.command('publish',self.create(c))
    def claimed(self,c=None): return self.command('claim',self.opened(c),{'role_id':'A','external_ref':'local-manual-1'})
    def submitted(self,t=None):
        t=t or self.claimed()
        return self.command('submit',t,{'role_id':'A','contract_version':t['contract_version'],'summary':'真实实现','changes':'commit/deadbeef（声明）','tests':'测试日志引用','limitations':'尚未试玩','artifacts':'evidence/test.log','stopped_writing':True})
    def reviewed(self): return self.command('review',self.submitted(),{'role_id':'A','outcome':'accepted','note':'核对差异与日志'})
    def accept(self,t): return self.command('accept',t,{'note':'集中核验','checks':[{'index':i,'outcome':'passed','evidence':'逐条证据'+str(i)} for i in range(2)]})
    def test_full_goal_to_explicit_acceptance(self):
        t=self.claimed();t=self.command('checkpoint',t,{'role_id':'A','completed':'完成模块','remaining':'验收','next_step':'检查原Job','original_jobs':'job-original'})
        self.assertEqual(t['roles']['A']['status'],'running');t=self.submitted(t);self.assertEqual(t['phase'],'review');t=self.command('review',t,{'role_id':'A','outcome':'accepted','note':'核对成果'})
        self.assertEqual(t['phase'],'awaiting_acceptance');t=self.accept(t);self.assertEqual(t['status'],'accepted');self.assertEqual(t['acceptance_review']['source'],'operator_review_not_automatic_test')
    def test_persisted_across_store_and_process_restart(self):
        t=self.create();store=TaskStore(self.path);self.assertEqual(store.get(t['id']),t);self.assertEqual(store.store_id,self.store.store_id)
        code='import sys;sys.path.insert(0,sys.argv[1]);from task_store import TaskStore;from pathlib import Path;print(TaskStore(Path(sys.argv[2])).get(sys.argv[3])["id"])'
        p=subprocess.run([sys.executable,'-B','-c',code,str(ROOT/'scripts'),str(self.path),t['id']],capture_output=True,text=True,timeout=10);self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout.strip(),t['id'])
    def test_same_request_returns_original_receipt(self):
        req=str(uuid.uuid4());a=self.command('create',data={'contract':example()},request=req);self.command('publish',a)
        b=self.command('create',data={'contract':example()},request=req);self.assertEqual(a,b);self.assertEqual(len(self.store.listing()['tasks']),1);self.assertEqual(self.store.receipt(req)['receipt']['version'],1)
    def test_request_id_cannot_be_reused_with_new_parameters(self):
        req=str(uuid.uuid4());self.command('create',data={'contract':example()},request=req)
        c=example();c['goal']='different'
        with self.assertRaises(TaskError) as error:self.command('create',data={'contract':c},request=req)
        self.assertEqual(error.exception.code,'request_conflict')
    def test_compare_and_swap_preserves_other_window(self):
        t=self.create();a=self.command('publish',t)
        with self.assertRaises(TaskError) as error:self.command('cancel',t,{'reason':'stale'})
        self.assertEqual(error.exception.code,'version_conflict');self.assertEqual(self.store.get(t['id']),a)
    def test_concurrent_same_create_only_commits_once(self):
        req=str(uuid.uuid4())
        with ThreadPoolExecutor(4) as pool:items=list(pool.map(lambda _:self.command('create',data={'contract':example()},request=req),range(4)))
        self.assertEqual(len({i['id'] for i in items}),1);self.assertEqual(len(self.store.events(items[0]['id'])['events']),1)
    def test_concurrent_conflicting_claims_only_one_wins(self):
        c=example();a=self.opened(c);b=self.opened(c)
        def claim(t):
            try:self.command('claim',t,{'role_id':'A','external_ref':'ref'});return True
            except TaskError:return False
        with ThreadPoolExecutor(2) as pool:self.assertEqual(sum(pool.map(claim,[a,b])),1)
    def test_explicit_transaction_failure_leaves_no_receipt_or_event(self):
        t=self.opened();rid=str(uuid.uuid4())
        with patch('task_store.transition',side_effect=RuntimeError('controlled fixture')):
            with self.assertRaises(RuntimeError):self.command('pause',t,{'reason':'test'},rid)
        self.assertFalse(self.store.receipt(rid)['found']);self.assertEqual(self.store.get(t['id']),t);self.assertEqual(len(self.store.events(t['id'])['events']),2)
    def test_windows_path_case_and_slashes_compare_equal(self):self.assertEqual(absolute('D:/Sandbox/Project'),absolute('d:\\sandbox\\project'))
    def test_scope_conflict_cross_project_id_and_nested_path(self):
        a=self.claimed();c=example(path='D:/sandbox/project/src');c['roles'][0]['project_id']='another';c['roles'][0]['scopes']=['A/file.py'];b=self.opened(c)
        with self.assertRaises(TaskError) as e:self.command('claim',b,{'role_id':'A','external_ref':'r'})
        self.assertEqual(e.exception.code,'write_conflict')
    def test_similar_prefix_is_not_same_directory(self):
        self.claimed();c=example();c['roles'][0]['scopes']=['src/Another'];b=self.opened(c);self.assertEqual(self.command('claim',b,{'role_id':'A','external_ref':'r'})['phase'],'working')
    def test_separate_worktrees_can_run_in_parallel(self):
        self.claimed();b=self.claimed(example(path='D:/sandbox/worktree-b'));self.assertEqual(b['phase'],'working')
    def test_read_only_role_does_not_claim_write_ownership(self):
        self.claimed();c=example();c['roles'][0]['access']='read';c['roles'][0]['scopes']=[];b=self.claimed(c);self.assertEqual(b['phase'],'working')
    def test_blocked_and_paused_work_retains_write_ownership(self):
        a=self.claimed();a=self.command('block',a,{'role_id':'A','reason':'等待反馈'});a=self.command('pause',a,{'reason':'暂停协调'})
        b=self.opened()
        with self.assertRaises(TaskError):self.command('claim',b,{'role_id':'A','external_ref':'r'})
        a=self.command('release',a,{'role_id':'A','reason':'确认停止写入'});self.command('claim',b,{'role_id':'A','external_ref':'r'})
    def test_revision_refused_while_worker_active(self):
        a=self.claimed()
        with self.assertRaises(TaskError):self.command('revise',a,{'contract':example(),'reason':'change'})
    def test_revision_keeps_history_and_resets_acceptance(self):
        t=self.accept(self.reviewed());c=example();c['goal']='用户确认的新目标';new=self.command('revise',t,{'contract':c,'reason':'新增目标'})
        self.assertEqual(new['id'],t['id']);self.assertEqual(new['contract_version'],2);self.assertEqual(new['status'],'draft');self.assertIsNone(new['acceptance_review']);self.assertEqual(new['roles']['A']['status'],'pending');self.assertIn('accept',[e['action'] for e in self.store.events(t['id'])['events']])
    def test_dependencies_require_review_not_just_submit(self):
        c=example(ids=('A','B'));c['roles'][1]['depends_on']=['A'];t=self.opened(c)
        with self.assertRaises(TaskError):self.command('claim',t,{'role_id':'B','external_ref':'r'})
        t=self.command('claim',t,{'role_id':'A','external_ref':'r'});t=self.submitted(t)
        with self.assertRaises(TaskError):self.command('claim',t,{'role_id':'B','external_ref':'r'})
        t=self.command('review',t,{'role_id':'A','outcome':'accepted','note':'checked'});self.command('claim',t,{'role_id':'B','external_ref':'r'})
    def test_rework_returns_same_task_without_losing_submission_event(self):
        t=self.submitted();new=self.command('review',t,{'role_id':'A','outcome':'rework','note':'修复边界'});self.assertEqual(t['id'],new['id']);self.assertEqual(new['roles']['A']['status'],'pending');self.assertIsNotNone(new['roles']['A']['handoff'])
    def test_cannot_accept_from_empty_or_unreviewed_results(self):
        for t in [self.create(),self.opened(),self.submitted()]:
            with self.assertRaises(TaskError):self.accept(t)
    def test_every_acceptance_requires_evidence(self):
        t=self.reviewed()
        for checks in [[],[{'index':0,'outcome':'passed','evidence':''}],[{'index':i,'outcome':'not_run','evidence':'x'} for i in range(2)]]:
            with self.assertRaises(TaskError):self.command('accept',t,{'note':'result','checks':checks})
    def test_submission_requires_stopped_writing_and_current_contract(self):
        t=self.claimed();base={'role_id':'A','contract_version':1,'summary':'x','changes':'x','tests':'x','limitations':'','artifacts':'x','stopped_writing':True}
        for override in [{'contract_version':False},{'contract_version':0},{'stopped_writing':False}]:
            with self.assertRaises(TaskError):self.command('submit',t,base|override)
    def test_compact_web_session_can_bind_without_reassignment(self):
        sid='wc_sess_xtZ-pHxMTJ2jI0ap';self.observer.session=sid
        t=self.opened(example('web'));t=self.command('bind',t,{'role_id':'A','session_id':sid,'connection_id':self.observer.connection})
        self.assertEqual(t['roles']['A']['binding']['session_id'],sid)
        self.assertTrue(t['roles']['A']['binding']['not_account_authentication'])
        self.command('claim',t,{'role_id':'A'})
    def test_compact_web_session_still_requires_same_project_and_observation(self):
        sid='wc_sess_xtZ-pHxMTJ2jI0ap';self.observer.session=sid
        t=self.opened(example('web'));self.observer.project='agent:other:project'
        with self.assertRaises(TaskError) as error:self.command('bind',t,{'role_id':'A','session_id':sid,'connection_id':self.observer.connection})
        self.assertEqual(error.exception.code,'identity')

    def test_web_role_needs_observed_binding(self):
        t=self.opened(example('web'))
        with self.assertRaises(TaskError):self.command('claim',t,{'role_id':'A'})
        t=self.command('bind',t,{'role_id':'A','session_id':SID,'connection_id':self.observer.connection});self.assertEqual(t['roles']['A']['binding']['source'],'webcodex_read_observation');self.command('claim',t,{'role_id':'A'})
    def test_binding_rejects_wrong_session_project_connection_or_stale(self):
        t=self.opened(example('web'))
        for attr,value in [('session','wc_sess_wrong'),('project','other'),('connection','other'),('status','stale'),('path','D:/outside')]:
            old=getattr(self.observer,attr);setattr(self.observer,attr,value)
            with self.assertRaises(TaskError):self.command('bind',t,{'role_id':'A','session_id':SID,'connection_id':'wc-live-fixture'})
            setattr(self.observer,attr,old)
    def test_database_identity_marker_survives_restart(self):
        import sqlite3
        with closing(sqlite3.connect(self.path)) as db:self.assertEqual(db.execute('PRAGMA application_id').fetchone()[0],0x434C5754)
    def test_import_does_not_trust_passed_status_or_binding(self):
        t=self.accept(self.reviewed());bundle=json.loads(self.store.export(t['id'])['content']);new=self.command('import',data={'bundle':bundle})
        self.assertNotEqual(t['id'],new['id']);self.assertEqual(new['status'],'draft');self.assertEqual(new['contract'],t['contract']);self.assertIsNone(new['roles']['A']['binding']);self.assertIsNone(new['acceptance_review'])
    def test_export_preserves_complete_goal_and_recovery_refs(self):
        t=self.claimed();t=self.command('checkpoint',t,{'role_id':'A','completed':'part','remaining':'rest','next_step':'核对','original_jobs':'original-job-id'});text=self.store.export(t['id'],'A','markdown')['content']
        self.assertIn(t['contract']['goal'],text);self.assertIn('original-job-id',text);self.assertIn(t['contract_hash'],text);self.assertIn('不按时长',text)
    def test_large_event_history_is_byte_bounded_and_complete_over_pages(self):
        from task_domain import MAX_JSON,encoded
        c=example();c.update(goal='内'*24000,constraints='约'*16000,sources='文'*16000);c['roles'][0]['objective']='工'*8000
        t=self.create(c)
        for i in range(14):t=self.command('revise',t,{'contract':c,'reason':'明确修订 '+str(i)})
        first=self.store.events(t['id'],limit=50);self.assertIsNotNone(first['next_after']);self.assertLess(len(encoded(first).encode()),MAX_JSON+16384)
        second=self.store.events(t['id'],after=first['next_after'],limit=50);self.assertEqual(len(first['events'])+len(second['events']),15)
        imported=self.command('import',data={'bundle':json.loads(self.store.export(t['id'])['content'])});self.assertEqual(imported['contract']['goal'],c['goal'])
    def test_real_pagination_for_tasks_and_events(self):
        for _ in range(4):self.create()
        a=self.store.listing(limit=2);b=self.store.listing(after=a['next_after'],limit=2);self.assertEqual(len(a['tasks'])+len(b['tasks']),4);self.assertIsNone(b['next_after'])
        t=self.opened();a=self.store.events(t['id'],limit=1);b=self.store.events(t['id'],after=a['next_after'],limit=1);self.assertEqual([a['events'][0]['action'],b['events'][0]['action']],['create','publish'])
    def test_cancel_cannot_pretend_to_stop_active_work(self):
        t=self.claimed()
        with self.assertRaises(TaskError):self.command('cancel',t,{'reason':'cancel'})
    def test_unknown_action_and_missing_actor_rejected(self):
        t=self.opened()
        with self.assertRaises(TaskError):self.command('run_shell',t,{'role_id':'A'})
        with self.assertRaises(TaskError):self.store.command({'action':'create','actor':'','data':{'contract':example()},'request_id':str(uuid.uuid4())})
    def test_foreign_sqlite_database_is_not_adopted_or_modified(self):
        import sqlite3,hashlib
        foreign=Path(self.tmp.name)/'foreign.sqlite3'
        with closing(sqlite3.connect(foreign)) as db:db.execute('CREATE TABLE foreign_records (id INTEGER)')
        before=hashlib.sha256(foreign.read_bytes()).hexdigest()
        with self.assertRaises(TaskError):TaskStore(foreign)
        self.assertEqual(hashlib.sha256(foreign.read_bytes()).hexdigest(),before)
    def test_same_session_cannot_own_two_active_roles(self):
        t=self.opened(example('web',('A','B')))
        for rid in ('A','B'):t=self.command('bind',t,{'role_id':rid,'session_id':SID,'connection_id':self.observer.connection})
        t=self.command('claim',t,{'role_id':'A'})
        with self.assertRaises(TaskError) as error:self.command('claim',t,{'role_id':'B'})
        self.assertEqual(error.exception.code,'session_conflict')
    def test_bad_contract_variants(self):
        values=[]
        def alter(fn):c=example(ids=('A','B'));fn(c);values.append(c)
        alter(lambda c:c.update(goal=''));alter(lambda c:c.update(acceptance=[]));alter(lambda c:c['roles'][1].update(id='A'))
        alter(lambda c:c['roles'][0].update(depends_on=['absent']));alter(lambda c:c['roles'][0].update(depends_on=['A']))
        alter(lambda c:(c['roles'][0].update(depends_on=['B']),c['roles'][1].update(depends_on=['A'])))
        for path in ['../outside','/absolute','src/*','src/../escape','src/a.','C:/escape']:
            alter(lambda c,p=path:c['roles'][0].update(scopes=[p]))
        alter(lambda c:c['roles'][0].update(worktree='D:/outside'));alter(lambda c:c.update(api_key='not-allowed'));alter(lambda c:c.update(goal='sk-test_012345678901234567890123'))
        for c in values:
            with self.subTest(c=c):
                with self.assertRaises(TaskError):contract(c)

if __name__=='__main__':unittest.main(verbosity=2)
