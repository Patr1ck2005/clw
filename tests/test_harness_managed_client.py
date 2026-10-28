from pathlib import Path
import io,json,sys,unittest,uuid,runpy
from http.client import IncompleteRead
from urllib.error import URLError
from types import SimpleNamespace
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_managed_client import read_payload
from harness_state import HarnessError
import harness_managed_client as managed

class ManagedPayloadTests(unittest.TestCase):
    def test_read_only_long_result_preserves_formula_code_and_unicode(self):
        content=('中文结果 \\(x_1^2 + \\alpha\\)\n```python\nprint("✓")\n```\n'*1000)
        value={'request_id':'original','markdown':content}
        args=SimpleNamespace(payload_stdin=True,payload_file=None,payload_json=None)
        actual=read_payload(args,io.BytesIO(b'\xef\xbb\xbf'+json.dumps(value,ensure_ascii=False).encode()))
        self.assertEqual(actual,value)
    def test_oversized_stdin_is_rejected_without_reading_unbounded_input(self):
        args=SimpleNamespace(payload_stdin=True,payload_file=None,payload_json=None)
        with self.assertRaises(HarnessError):read_payload(args,io.BytesIO(b'x'*(256*1024+2)))


class ManagedEnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.operation='original-enroll-key'
        self.first_key=str(uuid.uuid5(uuid.NAMESPACE_URL,'first-task:'+self.operation))
        self.enrollment={'success':True,'state':'receiver_enrolled','target':'original-target',
            'thread_id':'original-thread','browser_marker':'original-marker',
            'first_task':{'request_id':'original-request','state':'queued','next':'first-task','model_sends':1}}
        self.waiting={'state':'waiting_local_slot','reason':'host_checkout_execution_busy',
            'request_id':'original-request','work_started':False}
        self.ready={'state':'first_task_ready','request':{'id':'original-request','claim_id':'original-claim'},
            'execution_context':{'access':'write','write_paths':['src']},'no_second_send':True}

    def cli(self,client,op='enroll',extra=(),operation=None):
        arguments=['harness_managed_client.py',op,'--store-id','original-store',
            '--target','original-target','--session-id','original-session',
            '--operation-id',operation or self.operation,*extra]
        output=io.StringIO()
        with patch.object(sys,'argv',arguments),patch.object(managed,'Client',return_value=client),\
             patch.object(sys,'stdout',output):
            managed.main()
        lines=output.getvalue().splitlines()
        self.assertEqual(len(lines),1,'CLI did not return a single complete response')
        return json.loads(lines[0])

    def test_default_cli_returns_waiting_with_original_enrollment_and_fixed_recheck(self):
        client=Mock();client.call.side_effect=[self.enrollment,self.waiting]
        with patch.object(managed.time,'sleep',side_effect=AssertionError('default enrollment waited')):
            result=self.cli(client)
        self.assertEqual(result['enrollment_receipt'],self.enrollment)
        self.assertEqual(result['first_task'],self.waiting)
        self.assertEqual((result['state'],result['work_started']),('waiting_local_slot',False))
        self.assertFalse(result['wait_timed_out'])
        self.assertEqual((result['next'],result['first_task_operation_id']),('first-task',self.first_key))
        self.assertNotIn('execution_context',result['first_task'])
        self.assertIn('same Web turn',result['message'])
        self.assertNotIn('wait-ready',result['message'])
        self.assertEqual(client.call.call_count,2)
        self.assertEqual(client.call.call_args_list[0].kwargs['op'],'enroll')
        self.assertEqual(client.call.call_args_list[1].kwargs,
            {'op':'first-task','operation_id':self.first_key,'payload':{}})
        self.assertEqual(self.enrollment['first_task']['state'],'queued')

    def test_default_cli_ready_uses_one_claim_attempt_without_waiting_or_second_send(self):
        client=Mock();client.call.side_effect=[self.enrollment,self.ready]
        with patch.object(managed.time,'sleep',side_effect=AssertionError('ready enrollment waited')):
            result=self.cli(client)
        self.assertEqual(result['first_task'],self.ready)
        self.assertEqual(client.call.call_count,2)
        self.assertEqual(client.call.call_args_list[1].kwargs['operation_id'],self.first_key)
        self.assertNotIn('waiting_local_slot',result.values())

    def test_bare_enrollment_keeps_original_receipt_without_claim_or_wait(self):
        enrollment={**self.enrollment,'first_task':None}
        client=Mock();client.call.return_value=enrollment
        with patch.object(managed.time,'sleep',side_effect=AssertionError('bare enrollment waited')):
            result=self.cli(client)
        self.assertEqual(result,enrollment)
        self.assertEqual(client.call.call_count,1)
        self.assertEqual(client.call.call_args.kwargs['op'],'enroll')

    def test_same_turn_cli_first_task_recheck_uses_original_key_without_enrolling_again(self):
        client=Mock();client.call.return_value=self.ready
        result=self.cli(client,op='first-task',operation=self.first_key)
        self.assertEqual(result,self.ready)
        client.call.assert_called_once_with('managed',op='first-task',operation_id=self.first_key,payload={})

    def test_first_task_rejection_keeps_enrollment_request_key_and_original_error(self):
        error=HarnessError('platform_refused',403)
        client=Mock();client.call.side_effect=[self.enrollment,error]
        with patch.object(managed.time,'sleep',side_effect=AssertionError('rejected claim retried')):
            result=self.cli(client)
        self.assertEqual(result['enrollment_receipt'],self.enrollment)
        self.assertEqual((result['state'],result['work_started']),('first_task_reconcile_required',False))
        self.assertTrue(result['completion_unknown'])
        self.assertFalse(result['replayed'])
        self.assertEqual((result['next'],result['first_task_operation_id']),('first-task',self.first_key))
        self.assertEqual(result['first_task']['request_id'],'original-request')
        self.assertEqual(result['first_task']['error'],
            {'type':'HarnessError','message':'platform_refused','code':'platform_refused','status':403})
        self.assertNotIn('execution_context',result['first_task'])
        self.assertEqual(client.call.call_count,2)

    def test_first_task_network_timeout_and_invalid_response_remain_unknown_without_replay(self):
        errors=[TimeoutError('original timeout'),URLError('original connection failure'),
            ValueError('original invalid response'),IncompleteRead(b'partial-response',12)]
        for error in errors:
            with self.subTest(type=type(error).__name__):
                client=Mock();client.call.side_effect=[self.enrollment,error]
                with patch.object(managed.time,'sleep',side_effect=AssertionError('unknown claim retried')):
                    result=self.cli(client)
                self.assertEqual(result['enrollment_receipt'],self.enrollment)
                self.assertEqual(result['state'],'first_task_reconcile_required')
                self.assertFalse(result['work_started'])
                self.assertTrue(result['completion_unknown'])
                self.assertEqual(result['first_task']['request_id'],'original-request')
                self.assertEqual(result['first_task']['error']['type'],type(error).__name__)
                self.assertEqual(result['first_task']['error']['message'],str(error))
                self.assertEqual(result['first_task_operation_id'],self.first_key)
                self.assertEqual(client.call.call_count,2)

    def test_error_after_explicit_wait_keeps_saved_enrollment_and_never_retries_failure(self):
        error=TimeoutError('original late timeout')
        client=Mock();client.call.side_effect=[self.enrollment,self.waiting,error]
        tick=[0]
        with patch.object(managed.time,'monotonic',side_effect=lambda:tick[0]),\
             patch.object(managed.time,'sleep',side_effect=lambda seconds:tick.__setitem__(0,tick[0]+seconds)):
            result=self.cli(client,extra=['--wait-first-task','--timeout-seconds','3'])
        self.assertEqual(result['state'],'first_task_reconcile_required')
        self.assertEqual(result['enrollment_receipt'],self.enrollment)
        self.assertEqual(result['first_task']['error']['message'],'original late timeout')
        self.assertEqual(client.call.call_count,3)
        self.assertEqual(client.call.call_args_list[1],client.call.call_args_list[2])

    def test_failure_before_enrollment_is_not_given_a_fabricated_receipt(self):
        errors=[HarnessError('managed_ticket_invalid',403),TimeoutError('original enroll timeout'),
            ValueError('original enroll invalid response')]
        for error in errors:
            with self.subTest(type=type(error).__name__):
                client=Mock();client.call.side_effect=error
                with self.assertRaises(type(error)) as caught:
                    self.cli(client)
                self.assertIs(caught.exception,error)
                client.call.assert_called_once_with('managed',op='enroll',
                    operation_id=self.operation,payload={})

    def test_script_registration_failure_prints_only_original_failure_without_receipt(self):
        errors=[HarnessError('managed_ticket_invalid',403),TimeoutError('original enroll timeout'),
            IncompleteRead(b'partial-response',12)]
        arguments=['harness_managed_client.py','enroll','--store-id','original-store',
            '--target','original-target','--session-id','original-session','--operation-id',self.operation]
        for error in errors:
            with self.subTest(type=type(error).__name__):
                client=Mock();client.call.side_effect=error;output=io.StringIO()
                with patch.object(sys,'argv',arguments),patch('harness_host_client.Client',return_value=client),\
                     patch.object(sys,'stdout',output):
                    with self.assertRaises(SystemExit) as stopped:
                        runpy.run_path(str(Path(managed.__file__)),run_name='__main__')
                self.assertEqual(stopped.exception.code,2)
                result=json.loads(output.getvalue())
                self.assertFalse(result['success'])
                self.assertEqual(result['code'],getattr(error,'code','managed_client_failed'))
                self.assertNotIn('enrollment_receipt',result)
                self.assertNotIn('first_task',result)
                client.call.assert_called_once()

    def test_explicit_cli_wait_is_bounded_and_never_claims_after_expiry(self):
        client=Mock();client.call.side_effect=[self.enrollment,self.waiting]
        tick=[0];sleeps=[]
        def sleep(seconds):sleeps.append(seconds);tick[0]+=seconds
        with patch.object(managed.time,'monotonic',side_effect=lambda:tick[0]),\
             patch.object(managed.time,'sleep',side_effect=sleep):
            result=self.cli(client,extra=['--wait-first-task','--timeout-seconds','1'])
        self.assertEqual(sleeps,[1])
        self.assertEqual(client.call.call_count,2)
        self.assertTrue(result['wait_timed_out'])
        self.assertEqual(result['state'],'waiting_local_slot')
        self.assertFalse(result['work_started'])
        self.assertEqual(result['enrollment_receipt'],self.enrollment)

    def test_existing_function_wait_default_rechecks_same_key_and_returns_ready(self):
        client=Mock();client.call.side_effect=[self.waiting,self.ready];sleeps=[]
        result=managed.enter_first_task(client,self.enrollment,self.operation,sleep=sleeps.append)
        self.assertEqual(result['first_task'],self.ready)
        self.assertEqual(sleeps,[2])
        self.assertEqual(client.call.call_args_list[0],client.call.call_args_list[1])

    def test_explicit_wait_call_consuming_deadline_does_not_sleep_or_reclaim(self):
        client=Mock();tick=[0]
        def call(*args,**kwargs):tick[0]=1;return self.waiting
        client.call.side_effect=call
        result=managed.enter_first_task(client,self.enrollment,self.operation,timeout=1,
            clock=lambda:tick[0],sleep=lambda _:self.fail('expired wait slept'))
        self.assertTrue(result['wait_timed_out'])
        client.call.assert_called_once()

    def test_first_task_requires_fixed_key_and_wait_flag_is_enroll_only(self):
        for args,code in ((['first-task'],'managed_fixed_operation_id_required'),
                          (['first-task','--operation-id',self.first_key,'--wait-first-task'],'managed_enroll_wait_only')):
            arguments=['harness_managed_client.py',*args,'--store-id','store','--target','target','--session-id','session']
            with self.subTest(args=args),patch.object(sys,'argv',arguments),patch.object(managed,'Client') as client:
                with self.assertRaisesRegex(HarnessError,code):managed.main()
                client.assert_not_called()

if __name__=='__main__':unittest.main()
