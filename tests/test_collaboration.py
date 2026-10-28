"""No-model two-role tests on the canonical isolated task journal."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_store import TaskStore
from task_domain import TaskError, fingerprint
from task_collaboration import artifact_path
from test_task_store import example, Observe, SID


def delivery(packet):
    return {'role_id':packet['role']['id'],'assignment_fence':packet['assignment_fence'],
        'session_id':(packet['binding'] or {}).get('session_id'),'project_id':packet['role']['project_id'],
        'account_label':'B-declared-fixture','summary':'完成独立模块','changes':'隔离样本','tests':'未调用模型；测试日志由主控核验',
        'limitations':'不是两个网页模型','input_baseline':'fixture input v1','head_commit':None,
        'artifacts':[{'path':'results/out.txt','sha256':hashlib.sha256(b'content').hexdigest(),'bytes':7}],
        'original_jobs':[],'stopped_writing':True}


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'tasks.sqlite3';self.observer=Observe();self.store=TaskStore(self.path,self.observer)
    def tearDown(self):self.temp.cleanup()
    def cmd(self,action,t=None,data=None,request_id=None):
        raw={'request_id':request_id or str(uuid.uuid4()),'action':action,'actor':'fixture M','data':data or {}}
        if t:raw.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(raw)['task']
    def start(self,ids=('A','B'),executor='manual',enable=True,c=None):
        t=self.cmd('create',data={'contract':c or example(executor,ids)})
        if enable:t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        t=self.cmd('publish',t)
        for rid in ids:
            if executor=='web':t=self.cmd('bind',t,{'role_id':rid,'session_id':SID,'connection_id':self.observer.connection})
            t=self.cmd('claim',t,{'role_id':rid,'external_ref':'independent-'+rid})
        return t
    def schema(self):
        with closing(sqlite3.connect(self.path)) as db:return db.execute("select value from metadata where key='schema_version'").fetchone()[0]
    def submit(self,t,rid='A',data=None):return self.cmd('deliver',t,data or delivery(self.store.assignment(t['id'],rid)))
    def review(self,t,rid='A',outcome='accepted'):
        return self.cmd('review_delivery',t,{'role_id':rid,'delivery_id':t['roles'][rid]['delivery']['id'],'outcome':outcome,'note':'核对原成果','evidence':'独立哈希与测试记录 fixture'})
    def test_capability_upgrade_is_explicit_and_does_not_change_tables(self):
        self.assertEqual(self.schema(),'1');t=self.cmd('create',data={'contract':example()})
        for value in (False,1,'true'):
            with self.assertRaises(TaskError):self.cmd('collaborate',t,{'confirm_schema_upgrade':value})
        self.assertEqual(self.schema(),'1');t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True});self.assertEqual(self.schema(),'2')
        self.assertEqual(TaskStore(self.path).get(t['id']),t)
        with closing(sqlite3.connect(self.path)) as db:self.assertEqual({r[0] for r in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")},{'tasks','events','receipts','metadata'})
    def test_cannot_take_over_active_legacy_role(self):
        t=self.start(ids=('A',),enable=False)
        with self.assertRaises(TaskError):self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        self.assertEqual(self.schema(),'1')
    def test_sibling_delivery_does_not_invalidate_other_assignment(self):
        t=self.start();a=self.store.assignment(t['id'],'A');b=self.store.assignment(t['id'],'B')
        t1=self.submit(t,'A',delivery(a));self.assertEqual(b['assignment_fence'],self.store.assignment(t['id'],'B')['assignment_fence'])
        t2=self.submit(t,'B',delivery(b));self.assertEqual(t2['version'],t1['version']+1)
        self.assertEqual({i['role_id'] for i in self.store.inbox()['items'][0]['items']},{'A','B'})
        self.assertEqual(t2['status'],'open')
    def test_simultaneous_two_workers_commit_without_parent_version_collision(self):
        t=self.start();payloads=[delivery(self.store.assignment(t['id'],r)) for r in ('A','B')]
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda d:self.submit(t,data=d),payloads))
        self.assertEqual(len({v['version'] for v in results}),2);self.assertEqual(len(self.store.inbox()['items'][0]['items']),2)
    def test_same_envelope_concurrently_produces_one_receipt(self):
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'));request=str(uuid.uuid4())
        with ThreadPoolExecutor(3) as pool:values=list(pool.map(lambda _:self.cmd('deliver',t,d,request),range(3)))
        self.assertEqual(values[0],values[1]);self.assertEqual([e['action'] for e in self.store.events(t['id'])['events']].count('deliver'),1)
    def test_request_conflict_does_not_overwrite_original(self):
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'));request=str(uuid.uuid4());a=self.cmd('deliver',t,d,request)
        with self.assertRaises(TaskError):self.cmd('deliver',t,{**d,'summary':'different'},request)
        self.assertEqual(self.store.get(t['id']),a)
    def test_local_feedback_invalidates_only_target_not_sibling(self):
        t=self.start();a=delivery(self.store.assignment(t['id'],'A'));b=delivery(self.store.assignment(t['id'],'B'))
        t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'加入用户的局部意见'})
        with self.assertRaises(TaskError) as error:self.submit(t,'A',a)
        self.assertEqual(error.exception.code,'assignment_changed');t=self.submit(t,'B',b)
        packet=self.store.assignment(t['id'],'A');self.assertEqual(packet['feedback_revision'],1);self.assertIn('局部意见',packet['feedback'][0]['note']);self.submit(t,'A',delivery(packet))
    def test_feedback_after_submission_requires_new_attempt_and_preserves_history(self):
        t=self.submit(self.start(ids=('A',)));old=t['roles']['A']['delivery']['id']
        t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'补充修改'})
        with self.assertRaises(TaskError):self.review(t)
        self.assertEqual(t['roles']['A']['status'],'pending');t=self.cmd('claim',t,{'role_id':'A','external_ref':'same-worker'})
        self.assertEqual(t['roles']['A']['attempt'],2);t=self.submit(t);self.assertNotEqual(old,t['roles']['A']['delivery']['id'])
        self.assertEqual([e['action'] for e in self.store.events(t['id'])['events']].count('deliver'),2)
    def test_rework_rejects_delayed_old_attempt(self):
        t=self.start(ids=('A',));old=delivery(self.store.assignment(t['id'],'A'));t=self.submit(t,data=old);t=self.review(t,outcome='rework');t=self.cmd('claim',t,{'role_id':'A','external_ref':'retry'})
        with self.assertRaises(TaskError):self.submit(t,data=old)
        self.submit(t)
    def test_shared_change_pauses_without_releasing_active_roles(self):
        t=self.start();t=self.cmd('feedback',t,{'role_id':'A','scope':'shared','note':'公共接口变化'})
        self.assertEqual(t['status'],'paused');self.assertEqual(t['roles']['B']['status'],'running')
        with self.assertRaises(TaskError):self.cmd('resume',t,{'reason':'绕过共同要求'})
        with self.assertRaises(TaskError):self.cmd('revise',t,{'contract':example(ids=('A','B')),'reason':'仍有人写'})
        for rid in ('A','B'):t=self.cmd('release',t,{'role_id':rid,'reason':'已核对停写'})
        t=self.cmd('revise',t,{'contract':example(ids=('A','B')),'reason':'纳入共同意见'})
        self.assertFalse(t['collaboration']['shared_change_pending']);self.assertTrue(t['collaboration']['enabled']);self.assertEqual(t['contract_version'],2)
    def test_active_downstream_blocks_local_reclassification(self):
        c=example(ids=('A','B'));c['roles'][1]['depends_on']=['A']
        t=self.start(ids=('A',),c=c);t=self.review(self.submit(t));t=self.cmd('claim',t,{'role_id':'B','external_ref':'child'})
        with self.assertRaises(TaskError) as e:self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'改变上游'})
        self.assertEqual(e.exception.code,'shared_change_required')
    def test_paused_task_can_collect_but_not_approve(self):
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'));t=self.cmd('pause',t,{'reason':'用户暂停'})
        t=self.submit(t,data=d);self.assertEqual(t['roles']['A']['status'],'submitted')
        with self.assertRaises(TaskError):self.review(t)
        t=self.cmd('resume',t,{'reason':'用户恢复'});self.review(t)
    def test_future_parent_version_is_not_accepted(self):
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'));t['version']+=1
        with self.assertRaises(TaskError):self.submit(t,data=d)
    def test_wrong_session_project_or_account_type_rejected(self):
        t=self.start(ids=('A',),executor='web');d=delivery(self.store.assignment(t['id'],'A'))
        for change in ({'session_id':'wc_sess_other'},{'project_id':'other'},{'account_label':123}):
            with self.subTest(change=change),self.assertRaises(TaskError):self.submit(t,data={**d,**change})
        t=self.submit(t,data=d);self.assertEqual(t['roles']['A']['delivery']['account_label'],'B-declared-fixture')
        self.assertIs(t['roles']['A']['binding']['not_account_authentication'],True)
    def test_unknown_native_work_and_missing_stop_rejected(self):
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'))
        for change in ({'stopped_writing':False},{'original_jobs':[{'id':'original','status':'unknown'}]},{'original_jobs':[{'id':'original','status':'running'}]},{'head_commit':'short'}):
            with self.assertRaises(TaskError):self.submit(t,data={**d,**change})
    def test_structured_role_cannot_use_legacy_submit_or_review(self):
        t=self.start(ids=('A',))
        with self.assertRaises(TaskError) as e:self.cmd('submit',t,{'role_id':'A'})
        self.assertEqual(e.exception.code,'structured_delivery_required');t=self.submit(t)
        with self.assertRaises(TaskError):self.cmd('review',t,{'role_id':'A','outcome':'accepted','note':'bypass'})
    def test_review_must_name_current_delivery_and_independent_evidence(self):
        t=self.submit(self.start(ids=('A',)));base={'role_id':'A','delivery_id':t['roles']['A']['delivery']['id'],'outcome':'accepted','note':'checked','evidence':'actual files'}
        for change in ({'delivery_id':'old'},{'evidence':''},{'outcome':'automatic'}):
            with self.assertRaises(TaskError):self.cmd('review_delivery',t,{**base,**change})
    def test_inbox_receipt_review_and_parent_acceptance_are_distinct(self):
        t=self.start()
        for rid in ('A','B'):t=self.submit(t,rid);t=self.review(t,rid)
        self.assertEqual(self.store.inbox()['items'][0]['items'][0]['kind'],'parent_acceptance')
        t=self.cmd('accept',t,{'note':'全部独立核验','checks':[{'index':i,'outcome':'passed','evidence':'核验依据'} for i in range(2)]})
        self.assertEqual(t['status'],'accepted');self.assertEqual(self.store.inbox()['items'],[])
    def test_import_is_new_draft_without_receipts_or_feedback_authority(self):
        t=self.submit(self.start(ids=('A',)));bundle=json.loads(self.store.export(t['id'])['content']);new=self.cmd('import',data={'bundle':bundle})
        self.assertNotIn('collaboration',new);self.assertNotIn('delivery',new['roles']['A']);self.assertEqual(new['status'],'draft')
    def test_artifact_paths_and_duplicate_hash_rows_rejected(self):
        for path in ('../x','/x','C:/x','a\\x','a/NUL.txt','a/COM1','a/.env','a/.git/x','.local/x','a/private_key','a/x.','a//b'):
            with self.subTest(path=path),self.assertRaises(TaskError):artifact_path(path)
        t=self.start(ids=('A',));d=delivery(self.store.assignment(t['id'],'A'))
        for rows in ([],d['artifacts']*2,[{**d['artifacts'][0],'bytes':True}],[{**d['artifacts'][0],'sha256':'fake'}]):
            with self.assertRaises(TaskError):self.submit(t,data={**d,'artifacts':rows})
    def test_unicode_artifact_names_are_preserved(self):self.assertEqual(artifact_path('成果/测试.txt'),'成果/测试.txt')
    def test_inbox_pages_are_bounded_and_reopen_persists_delivery(self):
        ids=[]
        for i in range(3):
            c=example(path=f'D:/fixture-{i}');t=self.submit(self.start(ids=('A',),c=c));ids.append(t['id'])
        first=self.store.inbox(limit=2);last=self.store.inbox(after=first['next_after'],limit=2)
        self.assertEqual(len(first['items'])+len(last['items']),3)
        self.assertEqual(len(TaskStore(self.path).inbox()['items']),3)
    def test_native_unknown_delegation_blocks_structured_delivery(self):
        t=self.start(ids=('A',));payload=delivery(self.store.assignment(t['id'],'A'))
        raw=deepcopy(t);raw['roles']['A']['delegation']={'id':'native-original','phase':'unknown'}
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('update tasks set data=? where id=?',(json.dumps(raw),t['id']));db.commit()
        with self.assertRaises(TaskError) as error:self.submit(t,data=payload)
        self.assertEqual(error.exception.code,'native_active')

    def test_assignment_fence_includes_store_identity(self):
        t=self.start(ids=('A',));from task_collaboration import assignment
        self.assertNotEqual(assignment(t,'A','a'*32)['assignment_fence'],assignment(t,'A','b'*32)['assignment_fence'])

if __name__=='__main__':unittest.main(verbosity=2)
