"""Sustained task decisions, authority fences and durable recovery, without models."""
from contextlib import closing
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_domain import TaskError
from task_store import TaskStore
from task_goals import limit_reason
from test_task_store import example
from test_collaboration import delivery


class GoalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'tasks.sqlite3';self.store=TaskStore(self.path)
    def tearDown(self):self.temp.cleanup()
    def cmd(self,action,t=None,data=None,request=None):
        raw={'request_id':request or str(uuid.uuid4()),'action':action,'actor':'B-declared-fixture-M','data':data or {}}
        if t:raw.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(raw)['task']
    def goal(self,ids=('A','B'),max_cycles=6,failure_limit=3):
        t=self.cmd('create',data={'contract':example(ids=ids)})
        t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        t=self.cmd('goal.enable',t,{'confirm_schema_upgrade':True,'max_cycles':max_cycles,'failure_limit':failure_limit})
        return self.cmd('publish',t)
    def cycle(self,t,outcome='progress',rework=False):
        for rid in t['roles']:
            t=self.cmd('claim',t,{'role_id':rid,'external_ref':'program-fixture-'+rid})
            t=self.cmd('deliver',t,delivery(self.store.assignment(t['id'],rid)))
            t=self.cmd('review_delivery',t,{'role_id':rid,'delivery_id':t['roles'][rid]['delivery']['id'],'outcome':'rework' if rework else 'accepted','note':'independent review','evidence':'fixture-file-hash-and-report'})
        return self.cmd('goal.review_cycle',t,{'expected_cycle':t['goal']['cycle'],'outcome':outcome,'note':'Actual route evidence','evidence':['reports/route.md']})
    def advance(self,t,roles=None,request=None,resolve=False):
        return self.cmd('goal.next_cycle',t,{'expected_cycle':t['goal']['cycle'],'review_id':t['goal']['review']['id'],'roles':roles or t['contract']['roles'],'resolve_shared_change':resolve},request)
    def test_three_cycles_keep_same_goal_and_explicit_final_acceptance(self):
        t=self.goal();identity=t['id'];intent=deepcopy(t['goal']['intent'])
        for n in range(1,4):
            t=self.cycle(t,'inconclusive' if n==1 else 'progress',rework=n==1)
            self.assertEqual(t['goal']['cycle'],n);self.assertEqual(t['id'],identity);self.assertEqual(t['goal']['intent'],intent)
            if n<3:t=self.advance(t)
        self.assertEqual(t['status'],'open')
        t=self.cmd('accept',t,{'checks':[{'index':i,'outcome':'passed','evidence':'original condition independently checked'} for i in range(2)],'note':'full original goal checked'})
        self.assertEqual(t['status'],'accepted');self.assertEqual(len(self.store.listing()['tasks']),1)
        events=self.store.events(identity,limit=100)['events'];self.assertEqual(sum(e['action']=='goal.next_cycle' for e in events),2)
    def test_explicit_schema_upgrade_never_recreates_tables(self):
        t=self.goal()
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("select value from metadata where key='schema_version'").fetchone()[0],'4')
            self.assertEqual({r[0] for r in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")},{'tasks','events','receipts','metadata'})
        self.assertEqual(TaskStore(self.path).get(t['id']),t)
    def test_resource_definition_cannot_downgrade_goal_store(self):
        t=self.goal();self.cmd('resource.define',t,{'namespace':'fixture','name':'seat','label':'Seat','capacity':1,'requires_frozen_inputs':False,'authority_ref':'fixture guard','confirm_schema_upgrade':True,'expected_resource_version':None})
        with closing(sqlite3.connect(self.path)) as db:self.assertEqual(db.execute("select value from metadata where key='schema_version'").fetchone()[0],'4')
    def test_old_task_without_goal_has_no_new_requirements(self):
        t=self.cmd('create',data={'contract':example()});self.cmd('revise',t,{'contract':example(),'reason':'ordinary draft update'})
        with closing(sqlite3.connect(self.path)) as db:self.assertEqual(db.execute("select value from metadata where key='schema_version'").fetchone()[0],'1')
    def test_active_legacy_cannot_be_taken_over(self):
        t=self.cmd('create',data={'contract':example()});t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True});t=self.cmd('publish',t);t=self.cmd('claim',t,{'role_id':'A','external_ref':'original'})
        with self.assertRaises(TaskError):self.cmd('goal.enable',t,{'confirm_schema_upgrade':True,'max_cycles':3,'failure_limit':2})
    def test_enable_confirmation_and_budgets_are_strict(self):
        t=self.cmd('create',data={'contract':example()});t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        for change in ({'confirm_schema_upgrade':1},{'max_cycles':True},{'max_cycles':101},{'failure_limit':0}):
            with self.subTest(change=change),self.assertRaises(TaskError):self.cmd('goal.enable',t,{'confirm_schema_upgrade':True,'max_cycles':3,'failure_limit':2,**change})
    def test_missing_or_unreviewed_delivery_blocks_cycle(self):
        t=self.goal(ids=('A',))
        with self.assertRaises(TaskError):self.cmd('goal.review_cycle',t,{'expected_cycle':1,'outcome':'progress','note':'skip','evidence':['x']})
        t=self.cmd('claim',t,{'role_id':'A','external_ref':'fixture'});t=self.cmd('deliver',t,delivery(self.store.assignment(t['id'],'A')))
        with self.assertRaises(TaskError):self.cmd('goal.review_cycle',t,{'expected_cycle':1,'outcome':'progress','note':'skip review','evidence':['x']})
    def test_review_is_not_goal_completion(self):
        t=self.cycle(self.goal());self.assertEqual(t['status'],'open');self.assertIsNone(t['acceptance_review'])
    def test_no_evidence_or_boolean_cycle_rejected(self):
        t=self.goal()
        for data in ({'expected_cycle':True,'completed':'','remaining':'work','next_step':'work','evidence':['report']},{'expected_cycle':1,'completed':'heartbeat','remaining':'work','next_step':'work','evidence':[]}):
            with self.assertRaises(TaskError):self.cmd('goal.checkpoint',t,data)
    def test_checkpoint_does_not_advance_cycle_or_claim(self):
        t=self.goal();t=self.cmd('goal.checkpoint',t,{'expected_cycle':1,'completed':'reviewed input','remaining':'implement','next_step':'read exact source','evidence':['reports/input.md']})
        self.assertEqual(t['goal']['cycle'],1);self.assertTrue(all(s['attempt']==0 for s in t['roles'].values()));self.assertEqual(t['status'],'open')
    def test_old_cycle_delivery_and_next_cycle_rejected(self):
        t=self.goal(ids=('A',));t=self.cmd('claim',t,{'role_id':'A','external_ref':'fixture'});old=delivery(self.store.assignment(t['id'],'A'));t=self.cmd('deliver',t,old)
        t=self.cmd('review_delivery',t,{'role_id':'A','delivery_id':t['roles']['A']['delivery']['id'],'outcome':'accepted','note':'check','evidence':'file'})
        t=self.cmd('goal.review_cycle',t,{'expected_cycle':1,'outcome':'progress','note':'continue','evidence':['r']});t=self.advance(t)
        t=self.cmd('claim',t,{'role_id':'A','external_ref':'new-cycle'})
        with self.assertRaises(TaskError):self.cmd('deliver',t,old)
        with self.assertRaises(TaskError):self.cmd('goal.checkpoint',t,{'expected_cycle':1,'completed':'old','remaining':'x','next_step':'x','evidence':['r']})
    def test_same_next_request_survives_reopen_and_concurrent_replay(self):
        t=self.cycle(self.goal());request=str(uuid.uuid4())
        with ThreadPoolExecutor(2) as pool:values=list(pool.map(lambda _:self.advance(t,request=request),range(2)))
        self.assertEqual(values[0],values[1]);self.store=TaskStore(self.path);self.assertEqual(self.advance(t,request=request),values[0])
        self.assertEqual(self.store.get(t['id'])['goal']['cycle'],2)
    def test_scope_root_executor_and_new_role_cannot_expand(self):
        t=self.cycle(self.goal(ids=('A',)))
        for delta in ({'worktree':'D:/other'},{'project_id':'agent:other:project'},{'scopes':['.']},{'executor':'codex'},{'id':'NEW'}):
            roles=deepcopy(t['contract']['roles']);roles[0].update(delta)
            with self.subTest(delta=delta),self.assertRaises(TaskError):self.advance(t,roles)
    def test_narrower_scope_and_objective_changes_are_allowed(self):
        t=self.cycle(self.goal(ids=('A',)));roles=deepcopy(t['contract']['roles']);roles[0].update(scopes=['src/A/subdir'],objective='Try the evidence-backed alternative')
        t=self.advance(t,roles);self.assertEqual(t['contract']['roles'][0]['scopes'],['src/A/subdir']);self.assertEqual(t['roles']['A']['binding'],None)
    def test_ordinary_revision_cannot_replace_original_goal(self):
        t=self.goal();c=deepcopy(t['contract']);c['goal']='different target'
        with self.assertRaises(TaskError) as e:self.cmd('revise',t,{'contract':c,'reason':'bypass'})
        self.assertEqual(e.exception.code,'goal_revision_required')
    def test_pause_and_shared_change_never_resume_implicitly(self):
        t=self.cycle(self.goal());t=self.cmd('pause',t,{'reason':'user pause'});t=self.advance(t);self.assertEqual(t['status'],'paused')
        with self.assertRaises(TaskError):self.cmd('claim',t,{'role_id':'A','external_ref':'cannot start'})
    def test_feedback_persists_in_next_cycle_assignment(self):
        t=self.goal(ids=('A',));t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'preserve user request across cycles'});t=self.cycle(t);t=self.advance(t)
        t=self.cmd('claim',t,{'role_id':'A','external_ref':'fixture'});p=self.store.assignment(t['id'],'A')
        self.assertEqual(p['goal']['cycle'],2);self.assertIn('preserve',p['feedback'][0]['note'])
    def test_failure_limit_blocks_work_without_erasing_evidence(self):
        t=self.cycle(self.goal(failure_limit=1),'failed_route',True);self.assertEqual(limit_reason(t),'failure_limit')
        with self.assertRaises(TaskError):self.advance(t)
        t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'new hint does not reset failure budget'})
        with self.assertRaises(TaskError):self.cmd('claim',t,{'role_id':'A','external_ref':'bypass'})
        self.assertIn('goal_budget',[i['kind'] for r in self.store.inbox()['items'] for i in r['items']])
    def test_cycle_limit_needs_explicit_budget_extension(self):
        t=self.cycle(self.goal(max_cycles=1));original=t['goal']['review']['id']
        with self.assertRaises(TaskError):self.advance(t)
        t=self.cmd('goal.extend_budget',t,{'expected_cycle':1,'max_cycles':3,'failure_limit':3,'confirm':True,'reason':'explicit scope-preserving extension'})
        self.assertEqual(t['goal']['review']['id'],original);self.assertEqual(self.advance(t)['goal']['cycle'],2)
    def test_review_cannot_be_reused_after_new_feedback(self):
        t=self.cycle(self.goal());t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'changed deliverable'})
        with self.assertRaises(TaskError):self.advance(t)
    def test_import_does_not_copy_goal_authority(self):
        t=self.cycle(self.goal());new=self.cmd('import',data={'bundle':json.loads(self.store.export(t['id'])['content'])})
        self.assertNotIn('goal',new);self.assertNotIn('collaboration',new);self.assertEqual(new['status'],'draft')
    def test_shared_change_has_stopped_only_replan_without_false_completion(self):
        t=self.goal(ids=('A',));t=self.cmd('claim',t,{'role_id':'A','external_ref':'original'});t=self.cmd('feedback',t,{'role_id':'A','scope':'shared','note':'new common input'})
        data={'expected_cycle':1,'roles':t['contract']['roles'],'confirm':True,'reason':'apply new common input','evidence':['reports/original-stopped.md']}
        with self.assertRaises(TaskError):self.cmd('goal.replan',t,data)
        t=self.cmd('release',t,{'role_id':'A','reason':'confirmed original process finished and no writing'})
        t=self.cmd('goal.replan',t,data);self.assertEqual(t['status'],'paused');self.assertEqual(t['goal']['cycle'],2)
        self.assertEqual(t['goal']['last_cycle']['outcome'],'interrupted_by_shared_change_not_completed');self.assertIn('new common input',t['roles']['A']['feedback'][0]['note'])
        with self.assertRaises(TaskError):self.cmd('claim',t,{'role_id':'A','external_ref':'cannot auto resume'})
    def test_replan_cannot_skip_regular_unfinished_work(self):
        t=self.goal()
        with self.assertRaises(TaskError):self.cmd('goal.replan',t,{'expected_cycle':1,'roles':t['contract']['roles'],'confirm':True,'reason':'skip ordinary review','evidence':['r']})

    def test_closed_goal_does_not_restart(self):
        t=self.goal();t=self.cmd('cancel',t,{'reason':'user stop'})
        with self.assertRaises(TaskError):self.cmd('goal.checkpoint',t,{'expected_cycle':1,'completed':'','remaining':'x','next_step':'x','evidence':['r']})

if __name__=='__main__':unittest.main(verbosity=2)
