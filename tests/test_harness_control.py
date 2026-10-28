"""Exact-turn control regressions. Synthetic transport; never calls a model."""
from pathlib import Path
import sys,tempfile,threading,time,unittest,uuid
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_rpc import RpcFailure
from test_harness_service import FakeConnection

class DelayedConnection(FakeConnection):
    def request(self,method,params,timeout=30):
        if method=='turn/start':
            self.calls.append((method,params));return {'turn':{'id':'turn-current','status':'inProgress'}}
        if method=='turn/interrupt':
            self.calls.append((method,params))
            if not getattr(self,'started',False):raise RpcFailure('rpc_error')
            if getattr(self,'finish_on_interrupt',False):
                self.callback({'method':'turn/completed','params':{'threadId':params['threadId'],'turn':{'id':params['turnId'],'status':'interrupted'}}})
            return {}
        if method=='turn/steer':
            self.calls.append((method,params))
            if getattr(self,'steer_unknown',False):raise RpcFailure('request_timeout',unknown=True)
            return {'turnId':params['expectedTurnId']}
        return super().request(method,params,timeout)

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.s=HarnessService(self.root,self.root/'state',connection_factory=DelayedConnection)
        self.s.control_start_wait_secs=.3
        self.row=self.cmd('thread.create',{'title':'exact control'})['thread']
        self.cmd('message.send',{'text':'original'})
    def tearDown(self):self.s.close();self.tmp.cleanup()
    def cmd(self,action,data=None,key=None):
        return self.s.command({'request_id':key or str(uuid.uuid4()),'action':action,'data':data or {},**({'thread_id':self.row['id']} if hasattr(self,'row') else {})})
    def event(self,method,turn='turn-current',status='inProgress'):
        if method=='turn/started':self.s.connection.started=True
        self.s.on_event({'method':method,'params':{'threadId':self.row['native_id'],'turn':{'id':turn,'status':status}}})
    def control(self,action,data=None):
        replies=[];thread=threading.Thread(target=lambda:replies.append(self.cmd(action,data)));thread.start();return thread,replies
    def finish(self,thread):thread.join(2);self.assertFalse(thread.is_alive())
    def calls(self,method):return [p for m,p in self.s.connection.calls if m==method]
    def test_immediate_stop_waits_for_native_start_not_only_rpc_acceptance(self):
        t,r=self.control('turn.stop');time.sleep(.02);self.assertEqual(self.calls('turn/interrupt'),[])
        self.event('turn/started');self.finish(t)
        self.assertEqual(r[0]['state'],'stop_requested_not_terminal');self.assertEqual(len(self.calls('turn/interrupt')),1)
        self.assertEqual(self.s.state.thread(self.row['id'])['status'],'stopping')
    def test_missing_start_is_bounded_and_never_interrupts_unobserved_work(self):
        self.s.control_start_wait_secs=.03;result=self.cmd('turn.stop')
        self.assertEqual(result['code'],'native_start_not_observed_no_control_sent');self.assertEqual(self.calls('turn/interrupt'),[])
    def test_completion_while_waiting_is_not_falsely_called_interrupted(self):
        t,r=self.control('turn.stop');time.sleep(.02);self.event('turn/completed',status='completed');self.finish(t)
        self.assertEqual(r[0]['state'],'already_terminal');self.assertEqual(r[0]['native_status'],'completed');self.assertEqual(self.calls('turn/interrupt'),[])
    def test_stale_completion_cannot_clear_new_active_turn(self):
        self.event('turn/started');self.event('turn/completed',turn='older-turn',status='completed')
        row=self.s.state.thread(self.row['id']);self.assertEqual(row['active_turn'],'turn-current');self.assertEqual(row['status'],'working')
    def test_late_started_event_cannot_resurrect_a_completed_turn(self):
        self.event('turn/completed',status='completed');self.event('turn/started')
        self.assertEqual(self.s.state.thread(self.row['id'])['status'],'idle')
    def test_actual_interrupt_terminal_event_is_not_overwritten(self):
        self.event('turn/started');self.s.connection.finish_on_interrupt=True;result=self.cmd('turn.stop')
        self.assertEqual(result['state'],'stop_requested_not_terminal');self.assertEqual(self.s.state.thread(self.row['id'])['status'],'interrupted')
    def test_same_stop_request_does_not_dispatch_twice(self):
        self.event('turn/started');key=str(uuid.uuid4());a=self.cmd('turn.stop',key=key);b=self.cmd('turn.stop',key=key)
        self.assertEqual(a,b);self.assertEqual(len(self.calls('turn/interrupt')),1)
    def test_steer_adds_input_to_exact_turn_without_starting_another(self):
        self.event('turn/started');result=self.cmd('message.steer',{'text':'additional scope','expected_turn_id':'turn-current'})
        self.assertEqual(result['state'],'steered_not_completed');self.assertEqual(len(self.calls('turn/start')),1)
        self.assertEqual(self.calls('turn/steer')[0]['expectedTurnId'],'turn-current')
        self.assertEqual(self.s.state.thread(self.row['id'])['status'],'working')
        self.assertTrue(any(e['kind']=='user_steering' for e in self.s.state.events(self.row['id'])['items']))
    def test_steer_wrong_turn_never_retargets(self):
        self.event('turn/started');result=self.cmd('message.steer',{'text':'stale input','expected_turn_id':'older-turn'})
        self.assertEqual(result['code'],'active_turn_changed');self.assertEqual(self.calls('turn/steer'),[])
    def test_unknown_steer_is_retained_without_repeat(self):
        self.event('turn/started');self.s.connection.steer_unknown=True;key=str(uuid.uuid4())
        data={'text':'exact input','expected_turn_id':'turn-current'};a=self.cmd('message.steer',data,key);b=self.cmd('message.steer',data,key)
        self.assertEqual(a,b);self.assertEqual(a['state'],'unknown');self.assertEqual(len(self.calls('turn/steer')),1)
    def test_old_native_history_cannot_clear_current_accepted_turn(self):
        result=self.cmd('thread.sync')
        self.assertEqual(result['thread']['active_turn'],'turn-current');self.assertEqual(result['thread']['status'],'working')
        self.assertFalse(result['state_applied']);self.assertEqual(len(self.calls('turn/start')),1)
    def test_native_sync_does_not_undo_pending_stop(self):
        self.event('turn/started');self.cmd('turn.stop')
        result=self.cmd('thread.sync')
        self.assertEqual(result['thread']['status'],'stopping');self.assertEqual(result['thread']['active_turn'],'turn-current')
        self.assertFalse(result['state_applied'])
    def test_stopping_thread_does_not_admit_new_steering(self):
        self.event('turn/started');self.cmd('turn.stop');result=self.cmd('message.steer',{'text':'no restart','expected_turn_id':'turn-current'})
        self.assertEqual(result['state'],'rejected');self.assertEqual(self.calls('turn/steer'),[])

if __name__=='__main__':unittest.main(verbosity=2)
