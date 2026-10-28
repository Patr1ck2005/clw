"""Supervisor tests use synthetic Popen handles and isolated directories only."""
from pathlib import Path
import json,sys,tempfile,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from harness_launcher import restart_decision,request_stop,stop_requested,status,supervise
from product_runtime import atomic_json,FileLease,ProductError

class LauncherTests(unittest.TestCase):
    def test_stop_precedes_crash_recovery(self):self.assertEqual(restart_decision(1,0,True,True,True),'stopped')
    def test_normal_exit_never_restarts(self):self.assertEqual(restart_decision(0,0,True,True,False),'normal_exit')
    def test_crash_budget_is_finite(self):
        self.assertEqual(restart_decision(1,2,True,True,False),'restart')
        self.assertEqual(restart_decision(1,3,True,True,False),'crash_budget_exhausted')
    def test_source_and_store_change_stop_automatic_restart(self):
        self.assertEqual(restart_decision(1,0,False,True,False),'source_changed_manual_restart')
        self.assertEqual(restart_decision(1,0,True,False,False),'state_changed_no_restart')
    def test_foreign_port_is_not_killed_or_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            rc=supervise(Path(d),port_check=lambda:True,popen=lambda *a,**k:self.fail('must not spawn'))
            self.assertEqual(rc,2);self.assertEqual(status(Path(d))['state'],'port_already_owned_no_process_stopped')
    def test_stale_stop_does_not_stop_new_instance(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);atomic_json(p/'stop.json',{'instance_id':'a'*32})
            self.assertFalse(stop_requested(p,'b'*32));self.assertTrue(stop_requested(p,'a'*32))
    def test_stop_is_an_exact_request_not_a_pid_kill(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'.local/harness-launcher';p.mkdir(parents=True)
            atomic_json(p/'owner.json',{'instance_id':'c'*32,'child_pid':123})
            r=request_stop(root);self.assertFalse(r['process_killed']);self.assertTrue(stop_requested(p,'c'*32))
    def test_no_existing_owner_is_not_implicitly_created(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(status(Path(d))['state'],'not_started')
            self.assertFalse((Path(d)/'.local').exists())
    def test_kernel_lease_excludes_second_launcher(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'.local/harness-launcher';p.mkdir(parents=True)
            with FileLease(p/'supervisor.lock'):
                with self.assertRaises(ProductError):supervise(root,port_check=lambda:False)
    def test_normal_child_exit_keeps_single_original_popen(self):
        class Child:
            pid=555;returncode=0
            def poll(self):return 0
        with tempfile.TemporaryDirectory() as d:
            calls=[]
            def spawn(cmd,**kw):calls.append(cmd);return Child()
            rc=supervise(Path(d),popen=spawn,port_check=lambda:False,fingerprint=lambda _: 'fixed',identity=lambda _: 'same')
            self.assertEqual(rc,0);self.assertEqual(len(calls),1)
            self.assertFalse(any('codex' in a.lower() for a in calls[0] if a!='-X'))
    def test_failed_children_exhaust_budget_without_replaying_tasks(self):
        class Child:
            pid=555;returncode=1
            def poll(self):return 1
        with tempfile.TemporaryDirectory() as d:
            now=[0.];calls=[]
            def spawn(cmd,**kw):calls.append(cmd);return Child()
            rc=supervise(Path(d),popen=spawn,port_check=lambda:False,fingerprint=lambda _: 'fixed',identity=lambda _: 'same',clock=lambda:now[0],sleep=lambda n:now.__setitem__(0,now[0]+n))
            self.assertEqual(rc,2);self.assertEqual(len(calls),4);self.assertEqual(status(Path(d))['state'],'crash_budget_exhausted')
    def test_restart_denied_after_source_change(self):
        class Child:
            pid=555;returncode=1
            def poll(self):return 1
        with tempfile.TemporaryDirectory() as d:
            values=iter(['old','old','new']);calls=[]
            def spawn(cmd,**kw):calls.append(cmd);return Child()
            supervise(Path(d),popen=spawn,port_check=lambda:False,fingerprint=lambda _:next(values),identity=lambda _: 'same')
            self.assertEqual(len(calls),1);self.assertEqual(status(Path(d))['state'],'source_changed_manual_restart')

    def test_log_drain_retains_a_bound_without_blocking_child_output(self):
        from harness_launcher import BoundedLog
        import io
        sink=io.BytesIO();drain=BoundedLog(io.BytesIO(b'x'*100),sink,maximum=16)
        facts=drain.finish();self.assertEqual(sink.getvalue(),b'x'*16);self.assertEqual(facts['dropped_bytes'],84)
    def test_source_change_during_backoff_prevents_respawn(self):
        class Child:
            pid=555;returncode=1
            def poll(self):return 1
        with tempfile.TemporaryDirectory() as d:
            now=[0.];calls=[]
            def spawn(cmd,**kw):calls.append(cmd);return Child()
            rc=supervise(Path(d),popen=spawn,port_check=lambda:False,fingerprint=lambda _: 'fixed' if now[0]<1 else 'changed',identity=lambda _: 'same',clock=lambda:now[0],sleep=lambda n:now.__setitem__(0,now[0]+n))
            self.assertEqual(rc,2);self.assertEqual(len(calls),1)
            self.assertEqual(status(Path(d))['state'],'source_changed_manual_restart')

    def test_real_owned_child_stop_and_bounded_output_cleanup(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);owned=[]
            def spawn(cmd,**kwargs):
                script='import signal,time; signal.signal(signal.SIGINT,lambda *a:exit(0)); '+('signal.signal(signal.SIGBREAK,lambda *a:exit(0)); ' if sys.platform=='win32' else '')+'print("isolated own child",flush=True); time.sleep(20)'
                p=subprocess.Popen([sys.executable,'-u','-c',script],**kwargs);owned.append(p);return p
            def health(r,pid,expected):
                request_stop(r);return {'state_id':'same','instance_id':'fixture-process'}
            rc=supervise(root,popen=spawn,port_check=lambda:False,health=health,fingerprint=lambda _: 'same',identity=lambda _: 'same')
            self.assertEqual(rc,0);self.assertEqual(len(owned),1);self.assertIsNotNone(owned[0].poll())
            self.assertEqual(status(root)['state'],'stopped')
            self.assertFalse(status(root)['runner_deadline_bypassed'])
    def test_health_identity_failure_stops_owned_child_without_restart(self):
        class Child:
            pid=555;returncode=None
            def poll(self):return self.returncode
            def send_signal(self,s):self.returncode=0
            def wait(self,timeout=None):return self.returncode
        with tempfile.TemporaryDirectory() as d:
            child=Child();calls=[]
            def health(*a):raise ProductError('launcher_health_owner_mismatch')
            def spawn(*a,**k):calls.append(1);return child
            rc=supervise(Path(d),popen=spawn,port_check=lambda:False,health=health,fingerprint=lambda _:'same',identity=lambda _:'same')
            self.assertEqual(rc,2);self.assertEqual(len(calls),1);self.assertIsNotNone(child.poll())
            self.assertEqual(status(Path(d))['state'],'identity_mismatch_no_restart')

if __name__=='__main__':unittest.main(verbosity=2)
