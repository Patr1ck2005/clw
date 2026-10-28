"""Canonical outbox tests with an explicitly fake no-model native transport."""
from contextlib import closing
from copy import deepcopy
from pathlib import Path
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_domain import TaskError, fail, now
from task_store import TaskStore
from task_routing import RoutingEngine, queue, MAX_NOTICES
from test_task_store import example
from test_collaboration import delivery


class FakeCommunication:
    def __init__(self):
        self.enabled=True;self.namespace='native-test-principal';self.calls=[];self.observations=[];self.records={};self.fail_after_accept=False;self.generation=1
    def capability(self):return {'configured':True,'dispatch_enabled':self.enabled,'host_auto_resume_verified':False}
    def check_target(self,agent_id,conversation_id,generation):
        self.observations.append((agent_id,conversation_id,generation))
        if generation!=self.generation or agent_id=='missing':fail('communication_generation','fixture mismatch',409)
        return {'agent_id':agent_id,'conversation_id':conversation_id,'controller_generation':generation,'namespace':self.namespace,'checked_at':now(),'native_host_available':False,'source':'isolated_fake_transport_not_native_proof','host_auto_resume_verified':False}
    def post(self,item):
        if not self.enabled:fail('communication_disabled','disabled',403)
        self.check_target(item['route']['agent_id'],item['route']['conversation_id'],item['route']['controller_generation'])
        self.calls.append(deepcopy(item));key=item['native_request']['idempotency_key']
        if key not in self.records:self.records[key]={'message_id':'message-'+uuid.uuid4().hex,'delivery_id':'delivery-'+uuid.uuid4().hex,'seq':len(self.records)+1,'delivery_state':'queued'}
        if self.fail_after_accept:raise OSError('synthetic lost reply, do not log this arbitrary text')
        return deepcopy(self.records[key])
    def observe(self,item):return deepcopy(self.records[item['native_request']['idempotency_key']])


class RoutingCase:
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'tasks.sqlite3';self.bridge=FakeCommunication();self.store=TaskStore(self.path,communication=self.bridge)
        self.engine=RoutingEngine(self.store,self.bridge,'http://127.0.0.1:12345')
    def tearDown(self):self.engine.stop();self.temp.cleanup()
    def cmd(self,action,t=None,data=None,request=None):
        raw={'action':action,'request_id':request or str(uuid.uuid4()),'actor':'B-declared-test','data':data or {}}
        if t:raw.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(raw)['task']
    def latest(self,t):return self.store.get(t['id'])
    def setup_task(self,bind=True,enable=True,ids=('A','B')):
        t=self.cmd('create',data={'contract':example(ids=ids)});t=self.cmd('collaborate',t,{'confirm_schema_upgrade':True})
        if bind:
            for key in ['coordinator',*['role:'+r for r in ids]]:t=self.bind(t,key)
        if enable:t=self.cmd('routing.enable',t,{'confirm':True,'failure_limit':3})
        return self.cmd('publish',t)
    def bind(self,t,key='role:A',agent=None,generation=1):
        return self.cmd('routing.bind',t,{'target':key,'agent_id':agent or 'agent-'+key.replace(':','-'),'conversation_id':'conversation-fixture','controller_generation':generation})
    def outbox(self,t):return self.latest(t)['routing']['outbox']


class RoutingTests(RoutingCase,unittest.TestCase):
    def test_disabled_task_or_backend_does_not_send(self):
        t=self.setup_task(enable=False);self.engine.step();self.assertEqual(self.bridge.calls,[])
        t=self.cmd('routing.enable',t,{'confirm':True,'failure_limit':3});self.bridge.enabled=False;self.engine.step();self.assertEqual(self.bridge.calls,[])
    def test_readonly_connection_cannot_enable_or_inherit_auth(self):
        self.bridge.enabled=False;t=self.setup_task(enable=False)
        with self.assertRaises(TaskError):self.cmd('routing.enable',t,{'confirm':True,'failure_limit':3})
        self.assertFalse(self.latest(t)['routing']['enabled'])
    def test_bind_uses_actual_native_preflight_and_original_request_replay(self):
        t=self.setup_task(bind=False,enable=False);data={'target':'role:A','agent_id':'agent-A','conversation_id':'conversation-fixture','controller_generation':1};request=str(uuid.uuid4())
        a=self.cmd('routing.bind',t,data,request);count=len(self.bridge.observations);self.bridge.generation=2
        self.assertEqual(self.cmd('routing.bind',t,data,request),a);self.assertEqual(len(self.bridge.observations),count)
    def test_wrong_generation_and_shared_agent_rejected(self):
        t=self.setup_task(enable=False)
        with self.assertRaises(TaskError):self.bind(t,generation=2)
        with self.assertRaises(TaskError):self.bind(t,'role:B','agent-role-A')
    def test_sends_one_notice_per_meaningful_state_not_per_poll(self):
        t=self.setup_task(ids=('A',));self.engine.step();first=self.outbox(t)[0];self.assertEqual(first['phase'],'posted')
        for _ in range(4):self.engine.step()
        self.assertEqual(len(self.bridge.calls),1);self.assertEqual(self.latest(t)['roles']['A']['status'],'pending')
        body=json.loads(first['native_request']['body']);self.assertEqual(body['store_id'],self.store.store_id);self.assertEqual(body['task_id'],t['id']);self.assertEqual(body['expected_controller_generation'],1)
    def test_two_independent_roles_receive_distinct_notices_without_claiming(self):
        t=self.setup_task();self.engine.step();self.engine.step()
        self.assertEqual({n['target'] for n in self.bridge.calls},{'role:A','role:B'});self.assertTrue(all(s['status']=='pending' for s in self.latest(t)['roles'].values()))
    def test_body_does_not_copy_user_arbitrary_prompt_or_secrets(self):
        t=self.setup_task(ids=('A',));self.engine.step();body=self.bridge.calls[0]['native_request']['body']
        self.assertNotIn(t['contract']['goal'],body);self.assertNotIn('Authorization',body);self.assertIn('This notice grants no authority',body)
    def test_lost_response_never_automatically_reposts(self):
        self.bridge.fail_after_accept=True;t=self.setup_task(ids=('A',));self.engine.step();self.assertEqual(self.outbox(t)[0]['phase'],'delivery_unknown')
        for _ in range(4):self.engine.step()
        self.assertEqual(len(self.bridge.calls),1);self.assertEqual(len(self.bridge.records),1)
    def test_explicit_same_retry_recovers_one_native_message(self):
        self.bridge.fail_after_accept=True;t=self.setup_task(ids=('A',));self.engine.step();original=self.outbox(t)[0];self.bridge.fail_after_accept=False
        t=self.cmd('routing.retry_same',self.latest(t),{'notice_id':original['id'],'confirm':True,'reason':'explicitly retry native idempotent original envelope'})
        self.engine.step();after=self.outbox(t)[0];self.assertEqual(after['id'],original['id']);self.assertEqual(after['native_request'],original['native_request']);self.assertEqual(len(self.bridge.records),1);self.assertEqual(after['phase'],'posted')
    def test_cannot_discard_or_retarget_unknown_send(self):
        self.bridge.fail_after_accept=True;t=self.setup_task(ids=('A',));self.engine.step();notice=self.outbox(t)[0]
        with self.assertRaises(TaskError):self.cmd('routing.discard_pending',self.latest(t),{'notice_id':notice['id'],'confirm':True,'reason':'unknown is not unsent'})
        with self.assertRaises(TaskError):self.bind(self.latest(t),'role:A','agent-new')
    def test_crash_after_intent_preserves_original_unknown(self):
        t=self.setup_task(ids=('A',));task_id,item=self.engine.reserve();self.assertEqual(self.outbox(t)[0]['phase'],'dispatching')
        restarted=RoutingEngine(TaskStore(self.path,communication=self.bridge),self.bridge,self.engine.origin);restarted.recover_startup();restarted.step()
        self.assertEqual(self.outbox(t)[0]['phase'],'delivery_unknown');self.assertEqual(self.bridge.calls,[]);restarted.stop()
    def test_second_engine_does_not_dispatch_already_reserved(self):
        t=self.setup_task(ids=('A',));self.engine.reserve();other=RoutingEngine(self.store,self.bridge,self.engine.origin)
        self.assertIsNone(other.reserve());self.assertEqual(self.bridge.calls,[]);other.stop()
    def test_pause_holds_pending_and_resume_does_not_lose_notice(self):
        t=self.setup_task(ids=('A',))
        with closing(self.store.connect()) as db:
            row=json.loads(db.execute('select data from tasks where id=?',(t['id'],)).fetchone()[0]);queue(row,self.store.store_id,self.engine.origin);db.execute('update tasks set data=? where id=?',(json.dumps(row),t['id']));db.commit()
        pending=self.outbox(t)[0];t=self.cmd('pause',self.latest(t),{'reason':'user draft/pause'});self.engine.step();self.assertEqual(self.bridge.calls,[]);self.assertEqual(self.outbox(t)[0]['phase'],'pending')
        t=self.cmd('resume',self.latest(t),{'reason':'user explicitly resumes'});self.engine.step();self.assertEqual(self.bridge.calls[0]['id'],pending['id'])
    def test_pause_after_intent_does_not_erase_an_accepted_receipt(self):
        t=self.setup_task(ids=('A',));task_id,item=self.engine.reserve();self.cmd('pause',self.latest(t),{'reason':'request in flight'})
        result=self.bridge.post(item);self.engine.merge(task_id,item,result);after=self.latest(t)
        self.assertEqual(after['status'],'paused');self.assertEqual(after['routing']['outbox'][0]['phase'],'posted')
    def test_different_backend_never_receives_bound_message(self):
        t=self.setup_task(ids=('A',));self.bridge.namespace='different-principal';self.engine.step();self.assertEqual(self.bridge.calls,[])
    def test_known_native_consumption_is_not_model_turn_or_completion(self):
        t=self.setup_task(ids=('A',));self.engine.step();notice=self.outbox(t)[0]
        self.bridge.records[notice['native_request']['idempotency_key']]['delivery_state']='consumed';self.engine.observe_one();after=self.latest(t)
        self.assertEqual(after['routing']['outbox'][0]['phase'],'consumed');self.assertEqual(after['roles']['A']['status'],'pending');self.assertEqual(after['status'],'open')
        event=self.store.events(t['id'],limit=100)['events'][-1];self.assertFalse(event['payload']['new_model_turn_verified'])
    def test_actual_delivery_generates_coordinator_attention(self):
        t=self.setup_task(ids=('A',));t=self.cmd('claim',t,{'role_id':'A','external_ref':'fixture'});t=self.cmd('deliver',t,delivery(self.store.assignment(t['id'],'A')))
        self.engine.step();self.assertEqual(self.bridge.calls[0]['target'],'coordinator');self.assertEqual(self.latest(t)['roles']['A']['status'],'submitted')
    def test_sibling_notice_does_not_invalidate_structured_delivery(self):
        t=self.setup_task();t=self.cmd('claim',t,{'role_id':'A','external_ref':'fixture'});packet=self.store.assignment(t['id'],'A');self.engine.step()
        after=self.cmd('deliver',t,delivery(packet));self.assertEqual(after['roles']['A']['status'],'submitted')
    def test_failure_limit_stops_other_pending_requests_until_explicit_reenable(self):
        t=self.setup_task();t=self.cmd('routing.enable',t,{'confirm':True,'failure_limit':1});self.bridge.fail_after_accept=True;self.engine.step();self.engine.step()
        self.assertEqual(len(self.bridge.calls),1);self.assertIn('routing_unknown',[i['kind'] for r in self.store.inbox()['items'] for i in r['items']])
    def test_import_does_not_inherit_routes_or_outbox(self):
        t=self.setup_task();self.engine.step();new=self.cmd('import',data={'bundle':json.loads(self.store.export(t['id'])['content'])})
        self.assertNotIn('routing',new);self.assertEqual(new['status'],'draft')
    def test_no_network_io_under_sqlite_transaction(self):
        t=self.setup_task(ids=('A',));original=self.bridge.post
        def verify(item):
            with closing(sqlite3.connect(self.path,timeout=.2,isolation_level=None)) as db:db.execute('BEGIN IMMEDIATE');db.rollback()
            return original(item)
        self.bridge.post=verify;self.engine.step();self.assertEqual(self.outbox(t)[0]['phase'],'posted')
    def test_proven_first_preflight_failure_does_not_become_unreconcilable_send(self):
        t=self.setup_task(ids=('A',));original=self.bridge.post
        def rejected(item):
            error=TaskError('communication_generation','known read preflight mismatch',409);error.notification_post_not_attempted=True;raise error
        self.bridge.post=rejected;self.engine.step();notice=self.outbox(t)[0]
        self.assertEqual(notice['phase'],'blocked_before_dispatch');self.assertFalse(notice['ever_dispatched']);self.assertEqual(self.bridge.calls,[])
        t=self.bind(self.latest(t),'role:A','new-explicit-agent');self.bridge.post=original;self.engine.step();self.assertEqual(len(self.bridge.calls),1)
        self.assertEqual(self.bridge.calls[0]['route']['agent_id'],'new-explicit-agent')
    def test_failed_preflight_on_prior_unknown_cannot_erase_possible_post(self):
        t=self.setup_task(ids=('A',));self.bridge.fail_after_accept=True;self.engine.step();notice=self.outbox(t)[0]
        t=self.cmd('routing.retry_same',self.latest(t),{'notice_id':notice['id'],'confirm':True,'reason':'same original key'})
        def rejected(item):
            error=TaskError('communication_generation','new preflight failed',409);error.notification_post_not_attempted=True;raise error
        self.bridge.post=rejected;self.engine.step();self.assertEqual(self.outbox(t)[0]['phase'],'delivery_unknown');self.assertEqual(len(self.bridge.records),1)
        with self.assertRaises(TaskError):self.bind(self.latest(t),'role:A','other-agent')

    def test_pending_retry_of_unknown_cannot_be_rebound_or_cancelled(self):
        self.bridge.fail_after_accept=True;t=self.setup_task(ids=('A',));self.engine.step();notice=self.outbox(t)[0]
        t=self.cmd('routing.retry_same',self.latest(t),{'notice_id':notice['id'],'confirm':True,'reason':'recover exact original outcome'})
        before=self.latest(t)
        with self.assertRaises(TaskError):self.bind(t,'role:A','new-agent')
        self.assertEqual(self.latest(t),before);self.assertEqual(self.outbox(t)[0]['phase'],'pending')
        with self.assertRaises(TaskError):self.cmd('routing.discard_pending',t,{'notice_id':notice['id'],'confirm':True,'reason':'must retain prior uncertainty'})

    def test_pending_unknown_retry_blocks_a_successor_notice(self):
        self.bridge.fail_after_accept=True;t=self.setup_task(ids=('A',));self.engine.step();original=self.outbox(t)[0]
        t=self.cmd('routing.retry_same',self.latest(t),{'notice_id':original['id'],'confirm':True,'reason':'recover original envelope'})
        t=self.cmd('claim',t,{'role_id':'A','external_ref':'already active manual work'})
        t=self.cmd('feedback',t,{'role_id':'A','scope':'local','note':'latest user requirement'})
        queue(t,self.store.store_id,self.engine.origin)
        own=[n for n in t['routing']['outbox'] if n['target']=='role:A']
        self.assertEqual(len(own),1);self.assertEqual(own[0]['native_request'],original['native_request'])

    def test_delivery_observation_uses_oldest_poll_not_task_order(self):
        first=self.setup_task(ids=('A',));self.engine.step();second=self.setup_task(ids=('A',));self.engine.step()
        with closing(self.store.connect()) as db:
            for task,when in ((first,100),(second,0)):
                current=json.loads(db.execute('select data from tasks where id=?',(task['id'],)).fetchone()[0])
                current['routing']['outbox'][0]['last_poll_at']=when
                db.execute('update tasks set data=? where id=?',(json.dumps(current),task['id']))
            db.commit()
        seen=[];original=self.bridge.observe
        def observe(item):seen.append(item['id']);return original(item)
        self.bridge.observe=observe
        from unittest.mock import patch
        with patch('task_routing.time.time',return_value=200):self.engine.observe_one()
        self.assertEqual(seen,[self.outbox(second)[0]['id']])

    def test_poll_bookkeeping_does_not_count_as_progress(self):
        t=self.setup_task(ids=('A',));self.engine.step();before=self.latest(t);events=len(self.store.events(t['id'],limit=100)['events']);self.engine.observe_one();after=self.latest(t)
        self.assertEqual(before['version'],after['version']);self.assertEqual(before['updated_at'],after['updated_at']);self.assertEqual(events,len(self.store.events(t['id'],limit=100)['events']))

if __name__=='__main__':unittest.main(verbosity=2)
