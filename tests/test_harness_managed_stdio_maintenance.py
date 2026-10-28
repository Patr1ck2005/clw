"""Private maintenance shutdown never routes through ordinary pause-all."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import io,json,sys,tempfile,threading,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_managed_stdio import start_pipe
from harness_state import HarnessError
REAL_THREAD=threading.Thread

class StdioMaintenanceTests(unittest.TestCase):
    def run_pipe(self,op,authorize):
        frames=[];tasks=[];pauses=[];shutdowns=[]
        service=SimpleNamespace(instance='a'*32,state=SimpleNamespace(id='original-store'),host_bridge=SimpleNamespace(managed=SimpleNamespace(browser=lambda *args:pauses.append(args))))
        server=SimpleNamespace(shutdown=lambda:shutdowns.append(True))
        thread=lambda **kwargs:SimpleNamespace(start=lambda:tasks.append(kwargs['target']))
        wire={'id':'original-key','op':op,'payload':{'original':'payload'}}
        with patch('harness_managed_stdio.threading.Thread',thread),patch('harness_managed_stdio.sys.stdin',SimpleNamespace(buffer=io.BytesIO((json.dumps(wire)+'\n').encode()))),patch('builtins.print',lambda text,**kwargs:frames.append(text)),patch('maintenance_exit_readiness.authorize_shutdown',authorize):
            start_pipe(service,server);tasks[0]()
        return service,frames,pauses,shutdowns
    def test_ready_contains_original_instance_and_successful_maintenance_does_not_pause(self):
        calls=[]
        def authorize(service,payload):calls.append((service,payload));return {'state':'maintenance_shutdown_accepted'}
        service,frames,pauses,shutdowns=self.run_pipe('maintenance-shutdown',authorize)
        self.assertEqual(json.loads(frames[0][18:]),{'protocol':'clw.managed-browser.v1','store_id':'original-store','instance_id':service.instance})
        self.assertTrue(json.loads(frames[1][12:])['ok']);self.assertEqual(calls,[(service,{'original':'payload'})]);self.assertEqual(pauses,[]);self.assertEqual(len(shutdowns),1)
    def test_explicit_maintenance_refusal_returns_rejection_without_shutdown_of_live_pipe(self):
        # EOF below legitimately closes the pipe-owned service; a refusal by
        # itself must neither pause nor call shutdown before the next read.
        def refused(*args):raise HarnessError('maintenance_jobs_active')
        service,frames,pauses,shutdowns=self.run_pipe('maintenance-shutdown',refused)
        self.assertFalse(json.loads(frames[1][12:])['ok']);self.assertEqual(json.loads(frames[1][12:])['code'],'maintenance_jobs_active');self.assertEqual(pauses,[])
        self.assertEqual(len(shutdowns),1)
    def test_readiness_and_shutdown_refusal_preserve_specific_execution_blockers(self):
        from ordinary_exit_readiness import refuse
        def refused(*args):refuse('maintenance_original_execution_unresolved','unknown_local_operation',
                                 thread_id='original-thread',operation_id='original-command',state='unknown')
        for op in ('maintenance-readiness','maintenance-shutdown'):
            with self.subTest(op=op),patch('maintenance_exit_readiness.readiness',refused):
                _,frames,pauses,_=self.run_pipe(op,refused)
                reply=json.loads(frames[1][12:]);self.assertFalse(reply['ok'])
                self.assertEqual(reply['blockers'],[{'kind':'unknown_local_operation','thread_id':'original-thread',
                                                   'operation_id':'original-command','state':'unknown'}])
                self.assertEqual(pauses,[])
    def test_ordinary_shutdown_keeps_its_explicit_user_pause_contract(self):
        service,frames,pauses,shutdowns=self.run_pipe('shutdown',lambda *args:self.fail('must not authorize maintenance'))
        self.assertEqual(pauses,[('pause-all',{})]);self.assertEqual(len(shutdowns),2)

class StdioFaultDiagnosticsTests(unittest.TestCase):
    def fault_pipe(self,folder,writer=None,wait_written=True,duplicate_failure=False):
        frames=[];tasks=[];calls=[];shutdowns=[];written=threading.Event()
        def browser(op,payload):
            calls.append((op,payload))
            if op=='wire':raise RuntimeError('SECRET-payload-and-credential')
            return {'read_only':True}
        service=SimpleNamespace(instance='a'*32,state=SimpleNamespace(id='original-store',path=Path(folder)/'harness.sqlite3'),
            host_bridge=SimpleNamespace(managed=SimpleNamespace(browser=browser)))
        wire=[{'id':'12345678-1234-1234-1234-123456789012','op':'wire',
            'payload':{'page_id':'web-12345678-1234-1234-1234-123456789012','objective':'SECRET-body','token':'SECRET-token'}},
            {'id':'22345678-1234-1234-1234-123456789012','op':'view','payload':{'page_id':'web-12345678-1234-1234-1234-123456789012'}}]
        if duplicate_failure:wire.insert(1,{**wire[0],'id':'32345678-1234-1234-1234-123456789012'})
        def thread(**kwargs):
            if kwargs['name']=='clw-managed-private-pipe':return SimpleNamespace(start=lambda:tasks.append(kwargs['target']))
            return REAL_THREAD(**kwargs)
        from product_runtime import atomic_json
        def save(*args):
            try:return (writer or atomic_json)(*args)
            finally:written.set()
        with (patch('harness_managed_stdio.threading.Thread',thread),patch('harness_managed_stdio.sys.stdin',
            SimpleNamespace(buffer=io.BytesIO(('\n'.join(json.dumps(row) for row in wire)+'\n').encode()))),
            patch('builtins.print',lambda text,**kwargs:frames.append(text)),patch('product_runtime.atomic_json',save)):
            start_pipe(service,SimpleNamespace(shutdown=lambda:shutdowns.append(True)));tasks[0]()
            if wait_written:self.assertTrue(written.wait(2),'diagnostic writer did not settle')
        return frames,calls,shutdowns
    def test_unknown_call_identity_is_saved_without_payload_and_next_read_still_completes(self):
        with tempfile.TemporaryDirectory() as folder:
            frames,calls,shutdowns=self.fault_pipe(folder)
            replies=[json.loads(row[12:]) for row in frames if row.startswith('CLW_MANAGED ')]
            diagnostic=json.loads((Path(folder)/'managed-pipe-error.json').read_text(encoding='utf-8'))
            self.assertEqual(replies[0]['code'],'managed_operation_unknown_reconcile')
            self.assertEqual(diagnostic['diagnostic_id'],replies[0]['diagnostic_id'])
            self.assertEqual(replies[0]['diagnostic_state'],'pending')
            self.assertEqual(diagnostic['frame_id'],replies[0]['id']);self.assertEqual(diagnostic['op'],'wire')
            self.assertEqual(diagnostic['exception_type'],'RuntimeError')
            self.assertEqual(diagnostic['identity'],{'page_id':calls[0][1]['page_id']})
            self.assertTrue(diagnostic['frames']);self.assertLessEqual(len(diagnostic['frames']),12)
            self.assertNotIn('SECRET',json.dumps(diagnostic));self.assertNotIn('SECRET',json.dumps(replies))
            self.assertTrue(replies[1]['ok']);self.assertEqual([row[0] for row in calls],['wire','view'])
            self.assertEqual(shutdowns,[True])
    def test_diagnostic_write_failure_keeps_original_unknown_reply_and_never_replays(self):
        with tempfile.TemporaryDirectory() as folder:
            def denied(*args):raise OSError('diagnostic unavailable')
            frames,calls,shutdowns=self.fault_pipe(folder,denied)
            replies=[json.loads(row[12:]) for row in frames if row.startswith('CLW_MANAGED ')]
            self.assertEqual(replies[0]['code'],'managed_operation_unknown_reconcile')
            self.assertEqual(replies[0]['diagnostic_state'],'pending');self.assertTrue(replies[1]['ok'])
            self.assertEqual([row[0] for row in calls],['wire','view']);self.assertEqual(shutdowns,[True])
    def test_never_returning_storage_cannot_block_pipe_or_create_more_writer_threads(self):
        with tempfile.TemporaryDirectory() as folder:
            entered=threading.Event();release=threading.Event();writers=[]
            def blocked(*args):
                writers.append(True);entered.set();release.wait(5)
            try:
                frames,calls,shutdowns=self.fault_pipe(folder,blocked,wait_written=False,duplicate_failure=True)
                self.assertTrue(entered.wait(1))
                replies=[json.loads(row[12:]) for row in frames if row.startswith('CLW_MANAGED ')]
                self.assertEqual([reply.get('code') for reply in replies[:2]],['managed_operation_unknown_reconcile']*2)
                self.assertEqual(replies[0]['diagnostic_state'],'pending');self.assertNotIn('diagnostic_id',replies[1])
                self.assertTrue(replies[2]['ok']);self.assertEqual(writers,[True])
                self.assertEqual([row[0] for row in calls],['wire','wire','view']);self.assertEqual(shutdowns,[True])
            finally:release.set()

if __name__=='__main__':unittest.main()
