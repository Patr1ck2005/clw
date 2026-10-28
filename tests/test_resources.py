"""Domain-neutral resource tests. All tasks/observations are isolated fixtures."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from pathlib import Path
import json
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_domain import TaskError, fingerprint
from task_store import TaskStore
import task_resources as resources
from test_task_store import example
from test_collaboration import delivery


class ResourceCase(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'tasks.sqlite3'
        self.store=TaskStore(self.path)
    def tearDown(self):self.tmp.cleanup()
    def cmd(self,action,t=None,data=None,request=None):
        raw={'action':action,'request_id':request or str(uuid.uuid4()),'actor':'B-declared-isolated-test','data':data or {}}
        if t:raw.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(raw)['task']
    def latest(self,t):return self.store.get(t['id'])
    def start(self,ids=('A','B','C'),path='D:/resource-fixture'):
        t=self.cmd('create',data={'contract':example(ids=ids,path=path)})
        t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True});t=self.cmd('publish',t)
        for rid in ids:t=self.cmd('claim',t,{'role_id':rid,'external_ref':'program-'+rid})
        return t
    def define(self,t,name='compute',capacity=1,freeze=False):
        t=self.cmd('resource.define',self.latest(t),{'namespace':'fixture-machine','name':name,'label':name,'capacity':capacity,
            'requires_frozen_inputs':freeze,'authority_ref':'isolated test authority, not OS authentication',
            'confirm_schema_upgrade':True,'expected_resource_version':None})
        return t,t['resource_definitions'][-1]
    def observe(self,t,key,capacity=1,availability='available',at=None,ttl=600):
        r=next(x for x in self.store.resources()['resources'] if x['id']==key)
        return self.cmd('resource.observe',self.latest(t),{'resource_id':key,'expected_resource_version':r['version'],
            'availability':availability,'available_capacity':capacity,'source_observed_at':time.time() if at is None else at,
            'valid_for_seconds':ttl,'evidence':'explicit fixture external observation'})
    def request(self,t,rid,keys,inputs=None,units=None):
        packet=self.store.assignment(t['id'],rid)
        return self.cmd('resource.request',self.latest(t),{'role_id':rid,'assignment_fence':packet['assignment_fence'],
            'requirements':[{'resource_id':key,'units':units or 1} for key in keys],
            'inputs':inputs or [],'freeze_confirmed':True,'guard_evidence':'isolated stopped writers verified'})
    def group(self,t,rid='A'):return self.latest(t)['roles'][rid]['resource_request']
    def act(self,t,action,rid='A',**extra):
        group=self.group(t,rid)
        return self.cmd('resource.'+action,self.latest(t),{'role_id':rid,'resource_request_id':group['id'],'resource_fence':group['fence'],**extra})
    def begin(self,t,rid='A'):
        return self.act(t,'begin',rid,input_snapshot_hash=self.group(t,rid)['input_snapshot_hash'],inputs_verified=True,guard_evidence='verified explicit fixture bytes')
    def job(self,t,rid='A',jid='original-job'):
        role=next(x for x in t['contract']['roles'] if x['id']==rid)
        return {'executor':'isolated-process','id':jid,'project_id':role['project_id'],'session_id':None}
    def finish(self,t,rid='A'):
        self.begin(t,rid);job=self.job(t,rid)
        self.act(t,'attach',rid,original_job=job,evidence='exact original identity observed')
        return self.act(t,'finish',rid,original_job=job,terminal_status='completed',process_stopped=True,evidence='isolated terminal observation')
    def submit(self,t,rid='A'):
        data=delivery(self.store.assignment(t['id'],rid));data['artifacts'][0]['path']='src/'+rid+'/out.txt'
        return self.cmd('deliver',self.latest(t),data)
    def source(self,t,rid='A'):
        s=self.latest(t)['roles'][rid]['delivery']
        return {'role_id':rid,'delivery_id':s['id'],'paths':[x['path'] for x in s['artifacts']]}
    def schema(self):
        with closing(sqlite3.connect(self.path)) as db:return db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0]


class ResourceTests(ResourceCase):
    def test_define_explicit_schema3_and_later_collaboration_never_downgrades(self):
        t=self.start();self.assertEqual(self.schema(),'2');t,key=self.define(t)
        self.assertEqual(self.schema(),'3');other=self.cmd('create',data={'contract':example(path='D:/other')})
        self.cmd('collaborate',other,{'confirm_schema_upgrade':True});self.assertEqual(self.schema(),'3')
        self.assertEqual(TaskStore(self.path).resources()['resources'][0]['id'],key)
    def test_definition_needs_optin_and_uses_one_stable_identity(self):
        t=self.start();t,key=self.define(t);r=self.store.resources()['resources'][0]
        data={k:r[k] for k in ('namespace','name','label','capacity','requires_frozen_inputs','authority_ref')}
        data.update(confirm_schema_upgrade=False,expected_resource_version=r['version'])
        with self.assertRaises(TaskError):self.cmd('resource.define',t,data)
        data.update(confirm_schema_upgrade=True,namespace='FIXTURE-MACHINE',name='COMPUTE')
        self.cmd('resource.define',t,data);self.assertEqual(len(self.store.resources()['resources']),1)
    def test_boolean_capacity_and_observation_rejected(self):
        t=self.start();t,key=self.define(t)
        for cap in (True,-1,2):
            with self.assertRaises(TaskError):self.observe(t,key,cap)
    def test_unobserved_resource_waits_then_observation_grants_without_worker_poll(self):
        t=self.start();t,key=self.define(t);t=self.request(t,'A',[key]);self.assertEqual(self.group(t)['phase'],'queued')
        t=self.observe(t,key);self.assertEqual(t['roles']['A']['resource_request']['phase'],'reserved')
        self.assertEqual(t,self.latest(t));self.assertFalse(self.store.resources()['model_dispatch'])
    def test_source_time_not_receipt_time_determines_freshness(self):
        t=self.start();t,key=self.define(t);t=self.observe(t,key,at=time.time()-100,ttl=10)
        self.request(t,'A',[key]);self.assertEqual(self.group(t)['phase'],'queued')
        before=self.latest(t);self.store.coordinate_resources();self.assertEqual(before,self.latest(t))
    def test_late_observation_cannot_replace_new_one(self):
        t=self.start();t,key=self.define(t);at=time.time();self.observe(t,key,at=at)
        with self.assertRaises(TaskError) as e:self.observe(t,key,at=at-1)
        self.assertEqual(e.exception.code,'resource_observation_stale')
    def test_future_time_boolean_time_and_large_ttl_rejected(self):
        t=self.start();t,key=self.define(t)
        for at,ttl in ((time.time()+100,600),(True,30),(time.time(),601)):
            with self.assertRaises(TaskError):self.observe(t,key,at=at,ttl=ttl)
    def test_all_or_none_does_not_hold_partial_group(self):
        t=self.start();t,x=self.define(t,'x');t,y=self.define(t,'y');self.observe(t,x)
        t=self.request(t,'A',[x,y]);self.assertEqual(self.group(t)['phase'],'queued')
        self.assertTrue(all(r['occupied']==0 for r in self.store.resources()['resources']))
        self.observe(t,y);self.assertEqual(self.group(t)['phase'],'reserved')
        self.assertTrue(all(r['occupied']==1 for r in self.store.resources()['resources']))
    def test_fifo_overlap_and_unrelated_resources_progress(self):
        t=self.start();t,x=self.define(t,'x');t,y=self.define(t,'y');t,z=self.define(t,'z')
        self.observe(t,x);self.observe(t,z)
        self.request(t,'A',[x,y]);self.request(t,'B',[x]);self.request(t,'C',[z])
        self.assertEqual([self.group(t,r)['phase'] for r in ('A','B','C')],['queued','queued','reserved'])
        self.act(t,'cancel','A',reason='head withdrawn before start');self.assertEqual(self.group(t,'B')['phase'],'reserved')
    def test_two_concurrent_tasks_never_overbook_shared_resource(self):
        a=self.start(ids=('A',));b=self.start(ids=('A',),path='D:/other-fixture');a,key=self.define(a);self.observe(a,key)
        with ThreadPoolExecutor(2) as pool:list(pool.map(lambda t:self.request(t,'A',[key]),[a,b]))
        self.assertEqual(sorted([self.group(a)['phase'],self.group(b)['phase']]),['queued','reserved'])
        self.assertEqual(self.store.resources()['resources'][0]['occupied'],1)
    def test_request_receipt_is_idempotent_after_automatic_reservation(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);t=self.latest(t);p=self.store.assignment(t['id'],'A')
        d={'role_id':'A','assignment_fence':p['assignment_fence'],'requirements':[{'resource_id':key,'units':1}],'inputs':[],'freeze_confirmed':True,'guard_evidence':'checked'}
        request=str(uuid.uuid4());first=self.cmd('resource.request',t,d,request);second=self.cmd('resource.request',t,d,request)
        self.assertEqual(first,second);self.assertEqual(self.group(t)['generation'],1)
    def test_reservation_is_not_an_execution_and_requires_begin(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key])
        with self.assertRaises(TaskError):self.act(t,'attach',original_job=self.job(t),evidence='no intent yet')
        self.assertIsNone(self.group(t)['execution']);self.assertIsNone(self.group(t)['start_intent'])
    def test_capacity_drop_blocks_reserved_start_even_when_nonzero(self):
        t=self.start();t,key=self.define(t,capacity=2);self.observe(t,key,2);self.request(t,'A',[key],units=2);self.observe(t,key,1)
        with self.assertRaises(TaskError) as e:self.begin(t)
        self.assertEqual(e.exception.code,'resource_observation_stale');self.assertEqual(self.group(t)['phase'],'reserved')
    def test_starting_unknown_and_running_never_released_by_expiry(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);self.begin(t)
        self.act(t,'unknown',reason='execution reply missing')
        with patch.object(resources,'time_now',return_value=time.time()+10000):
            self.store.coordinate_resources();row=self.store.resources()['resources'][0]
            self.assertEqual(row['occupied'],1);self.assertEqual(row['grantable'],0)
        self.assertEqual(self.group(t)['phase'],'unknown')
        with self.assertRaises(TaskError):self.act(t,'cancel',reason='timeout is not stopped')
    def test_original_job_cannot_be_replaced_or_falsely_finished(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);self.begin(t);job=self.job(t)
        self.act(t,'attach',original_job=job,evidence='original accepted')
        for altered in ({**job,'id':'replacement'},{**job,'project_id':'other'}):
            with self.assertRaises(TaskError):self.act(t,'finish',original_job=altered,terminal_status='completed',process_stopped=True,evidence='wrong job')
        with self.assertRaises(TaskError):self.act(t,'attach',original_job=job,evidence='duplicate attach')
        with self.assertRaises(TaskError):self.act(t,'finish',original_job=job,terminal_status='completed',process_stopped=False,evidence='not stopped')
        self.act(t,'finish',original_job=job,terminal_status='failed',process_stopped=True,evidence='original terminal failure')
        self.assertEqual(self.store.resources()['resources'][0]['occupied'],0)
    def test_reconcile_no_execution_is_explicit_and_cannot_erase_known_job(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);self.begin(t)
        with self.assertRaises(TaskError):self.act(t,'reconcile_not_started',confirmed_no_execution=False,evidence='not checked')
        self.act(t,'reconcile_not_started',confirmed_no_execution=True,evidence='original dispatcher confirms never accepted')
        self.assertEqual(self.group(t)['phase'],'cancelled');self.request(t,'A',[key]);self.begin(t)
        self.act(t,'attach',original_job=self.job(t),evidence='known job')
        with self.assertRaises(TaskError):self.act(t,'reconcile_not_started',confirmed_no_execution=True,evidence='must not erase')
    def test_pause_and_block_prevent_start_without_releasing_unknown(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);t=self.cmd('pause',self.latest(t),{'reason':'user stop'})
        with self.assertRaises(TaskError):self.begin(t)
        t=self.cmd('resume',self.latest(t),{'reason':'user continue'});t=self.cmd('block',t,{'role_id':'A','reason':'needs review'})
        with self.assertRaises(TaskError):self.begin(t)
        t=self.cmd('unblock',t,{'role_id':'A','reason':'checked'});self.begin(t);self.cmd('pause',self.latest(t),{'reason':'stop coordination'})
        self.act(t,'unknown',reason='original effect unknown');self.assertEqual(self.group(t)['phase'],'unknown')
    def test_blocked_queue_not_given_new_window(self):
        t=self.start();t,key=self.define(t);self.request(t,'A',[key]);self.cmd('block',self.latest(t),{'role_id':'A','reason':'needs help'})
        self.observe(t,key);self.assertEqual(self.group(t)['phase'],'queued')
        self.cmd('unblock',self.latest(t),{'role_id':'A','reason':'resolved'});self.assertEqual(self.group(t)['phase'],'reserved')
    def test_outstanding_resources_block_release_delivery_and_contract_revision(self):
        t=self.start();t,key=self.define(t);self.request(t,'A',[key])
        for action,data in [('release',{'role_id':'A','reason':'not settled'}),('deliver',delivery(self.store.assignment(t['id'],'A'))),('revise',{'contract':t['contract'],'reason':'not settled'})]:
            with self.assertRaises(TaskError) as e:self.cmd(action,self.latest(t),data)
            self.assertEqual(e.exception.code,'resource_unsettled')
    def test_resource_definition_cannot_change_while_queued(self):
        t=self.start();t,key=self.define(t);self.request(t,'A',[key]);r=self.store.resources()['resources'][0]
        d={k:r[k] for k in ('namespace','name','label','capacity','requires_frozen_inputs','authority_ref')};d.update(confirm_schema_upgrade=True,expected_resource_version=r['version'])
        with self.assertRaises(TaskError):self.cmd('resource.define',self.latest(t),d)
    def test_actual_inputs_required_for_freezing_resource(self):
        t=self.start();t,key=self.define(t,freeze=True);self.observe(t,key)
        with self.assertRaises(TaskError):self.request(t,'B',[key])
        with self.assertRaises(TaskError):self.request(t,'B',[key],[{'role_id':'A','delivery_id':'not-delivered','paths':['src/A/out.txt']}])
    def test_only_delivered_subset_frozen_unrelated_writer_can_continue(self):
        t=self.start();t=self.submit(t,'A');t,key=self.define(t,freeze=True);self.observe(t,key)
        self.request(t,'B',[key],[self.source(t,'A')]);self.assertEqual(self.group(t,'B')['phase'],'reserved')
        t=self.cmd('feedback',self.latest(t),{'role_id':'A','scope':'local','note':'change source after freeze'})
        with self.assertRaises(TaskError) as e:self.cmd('claim',t,{'role_id':'A','external_ref':'new-source'})
        self.assertEqual(e.exception.code,'input_frozen')
        self.submit(t,'C');self.assertEqual(self.latest(t)['roles']['C']['status'],'submitted')
        with self.assertRaises(TaskError):self.begin(t,'B')
    def test_downstream_result_and_parent_acceptance_invalidated_transitively(self):
        t=self.start();self.submit(t,'A');t,key=self.define(t,freeze=True);self.observe(t,key)
        self.request(t,'B',[key],[self.source(t,'A')]);self.finish(t,'B');self.submit(t,'B')
        self.request(t,'C',[key],[self.source(t,'B')]);self.finish(t,'C');self.submit(t,'C')
        self.cmd('feedback',self.latest(t),{'role_id':'A','scope':'local','note':'new source requirement'})
        current=self.latest(t)
        self.assertEqual([current['roles'][r]['status'] for r in ('A','B','C')],['pending']*3)
        self.assertIn('resource_input_invalidated',current['roles']['C']);self.assertIn('delivery',current['roles']['C'])
        with self.assertRaises(TaskError):self.cmd('accept',current,{'checks':[],'note':'old cannot pass'})
    def test_new_resource_request_invalidates_old_prepared_delivery(self):
        t=self.start();old=delivery(self.store.assignment(t['id'],'A'));t,key=self.define(t);self.observe(t,key)
        self.request(t,'A',[key]);self.finish(t)
        with self.assertRaises(TaskError) as e:self.cmd('deliver',self.latest(t),old)
        self.assertEqual(e.exception.code,'assignment_changed')
        result=self.submit(t);self.assertEqual(result['roles']['A']['delivery']['resource_evidence']['phase'],'released')
    def test_periodic_observation_does_not_fabricate_progress_events(self):
        t=self.start();t,key=self.define(t);self.request(t,'A',[key]);before=self.latest(t)
        events=self.store.events(t['id'])
        for _ in range(3):self.assertEqual(self.store.coordinate_resources(),0)
        self.assertEqual(before,self.latest(t));self.assertEqual(events,self.store.events(t['id']))
    def test_resource_claim_cannot_bypass_via_native_specialist(self):
        t=self.start();t,key=self.define(t);self.request(t,'A',[key]);t=self.latest(t)
        raw={'request_id':str(uuid.uuid4()),'action':'specialist.prepare','actor':'fixture','task_id':t['id'],'expected_version':t['version'],'data':{'role_id':'A'}}
        with self.assertRaises(TaskError) as e:self.store.specialist_edit(raw,lambda task,state:state.update(operator='bypass'))
        self.assertEqual(e.exception.code,'resource_external_executor_required');self.assertEqual(t,self.latest(t))
    def test_explicit_two_domain_resources_use_same_scheduler(self):
        t=self.start();t,compiler=self.define(t,'compiler');t,reviewer=self.define(t,'manuscript-reviewer',capacity=3)
        self.observe(t,compiler);self.observe(t,reviewer,3);self.request(t,'A',[compiler]);self.request(t,'B',[reviewer],units=2)
        self.assertEqual([self.group(t,r)['phase'] for r in ('A','B')],['reserved','reserved'])
    def test_stale_resource_fence_rejected_after_generation_change(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);old=self.group(t)
        self.act(t,'cancel',reason='not started');self.request(t,'A',[key])
        with self.assertRaises(TaskError):self.cmd('resource.unknown',self.latest(t),{'role_id':'A','resource_request_id':old['id'],'resource_fence':old['fence'],'reason':'late controller'})
    def test_wrong_job_binding_cannot_attach(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);self.begin(t)
        with self.assertRaises(TaskError):self.act(t,'attach',original_job={**self.job(t),'session_id':'wc_sess_other'},evidence='wrong session')
    def test_snapshot_hash_and_false_verification_cannot_start(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key])
        for changes in ({'input_snapshot_hash':'0'*64,'inputs_verified':True},{'input_snapshot_hash':self.group(t)['input_snapshot_hash'],'inputs_verified':False}):
            with self.assertRaises(TaskError):self.act(t,'begin',guard_evidence='not checked',**changes)
    def test_running_native_role_cannot_acquire_unrelated_resource_execution(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);raw=self.latest(t)
        raw['roles']['A']['delegation']={'id':'original-native','phase':'unknown'}
        with closing(sqlite3.connect(self.path)) as db:db.execute('UPDATE tasks SET data=? WHERE id=?',(json.dumps(raw),t['id']));db.commit()
        with self.assertRaises(TaskError) as e:self.request(t,'A',[key])
        self.assertEqual(e.exception.code,'native_active');self.assertNotIn('resource_request',self.latest(t)['roles']['A'])
    def test_same_original_job_cannot_occupy_two_independent_roles(self):
        t=self.start();t,key=self.define(t,capacity=2);self.observe(t,key,2)
        for rid in ('A','B'):self.request(t,rid,[key]);self.begin(t,rid)
        job=self.job(t,'A');self.act(t,'attach','A',original_job=job,evidence='first original')
        with self.assertRaises(TaskError) as e:self.act(t,'attach','B',original_job=job,evidence='same original twice')
        self.assertEqual(e.exception.code,'original_execution_conflict');self.assertIsNone(self.group(t,'B')['execution'])

    def test_catalog_malformed_does_not_reset_or_release(self):
        t=self.start();t,key=self.define(t);self.observe(t,key);self.request(t,'A',[key]);before=self.latest(t)
        with closing(sqlite3.connect(self.path)) as db:db.execute('UPDATE metadata SET value=? WHERE key=?',('malformed',resources.CATALOG_KEY));db.commit()
        with self.assertRaises(TaskError):self.store.coordinate_resources()
        self.assertEqual(self.latest(t),before)

if __name__=='__main__':unittest.main(verbosity=2)
