"""Synthetic local receipts only: no model, bridge, credentials or browser."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import read_codex_web_task as reader


class FakeClock:
    def __init__(self,on_sleep=None):
        self.now=0
        self.sleeps=[]
        self.on_sleep=on_sleep

    def sleep(self,seconds):
        self.sleeps.append(seconds)
        self.now+=seconds
        if self.on_sleep:self.on_sleep(len(self.sleeps))


class NativeWorkWaitTests(unittest.TestCase):
    def test_explicit_admission_action_resolves_relative_result_path(self):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name).resolve()
            (directory/'execution.json').write_text('{}',encoding='utf8')
            for flag,action_name in [('--settle-admission','settle_admission'),('--recover-admission','recover_admission')]:
                with self.subTest(flag=flag),patch.object(reader,'inspect',return_value={'admissionId':'original'}),patch.object(reader,action_name,return_value={'state':'held'}) as action,patch.object(reader,'admission_status',return_value={'state':'held'}) as status:
                    with contextlib.chdir(directory.parent):
                        self.cli([directory.name,flag])
                    self.assertEqual(action.call_args.args[1],directory)
                    self.assertEqual(status.call_args.args[1],directory)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.live={101,202}
        self.owner_patch=patch.object(reader,'alive',side_effect=lambda pid:pid in self.live)
        self.owner_patch.start()
        self.addCleanup(self.owner_patch.stop)

    def package(self,name,state='running',pid=101,**extra):
        directory=self.root/name
        directory.mkdir()
        self.receipt(directory,state,pid,**extra)
        return directory

    def receipt(self,directory,state,pid=101,**extra):
        (directory/'execution.json').write_text(json.dumps({'state':state,'ownerPid':pid,**extra}),encoding='utf8')

    def wait(self,directories,seconds,on_sleep=None):
        clock=FakeClock(on_sleep)
        with patch.object(reader.time,'monotonic',side_effect=lambda:clock.now),patch.object(reader.time,'sleep',side_effect=clock.sleep):
            result=reader.wait_for_packages(directories,seconds)
        return result,clock

    def cli(self,arguments):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):self.assertEqual(reader.main(arguments),0)
        return json.loads(output.getvalue())

    def test_any_package_returns_while_another_remains_running(self):
        first=self.package('first',pid=101)
        second=self.package('second',pid=202)
        def finish(_):
            self.receipt(first,'turn_completed',101,exitCode=0)
            self.live.remove(101)
        with patch.object(reader,'inspect') as inspect:
            result,clock=self.wait([first,second],20,finish)
        inspect.assert_not_called()
        self.assertEqual(clock.now,1)
        self.assertEqual(result['reason'],'any_ready')
        self.assertEqual(result['readyResultDirectories'],[str(first)])
        self.assertEqual([item['status'] for item in result['observations']],['ready','pending'])
        self.assertEqual(json.loads((second/'execution.json').read_text())['state'],'running')

    def test_timeout_does_not_stop_job_write_receipt_or_settle(self):
        directory=self.package('running',admissionId='original')
        original=(directory/'execution.json').read_bytes()
        with patch.object(reader,'settle_admission') as settle,patch.object(reader,'recover_admission') as recover:
            result,clock=self.wait([directory],2.5)
        self.assertEqual(result['reason'],'timeout')
        self.assertEqual(clock.now,2.5)
        self.assertIn(101,self.live)
        self.assertEqual((directory/'execution.json').read_bytes(),original)
        self.assertEqual(list(directory.iterdir()),[directory/'execution.json'])
        settle.assert_not_called();recover.assert_not_called()
        self.assertEqual(result['modelSends'],0)
        self.assertFalse(result['claimReleaseVerified'])

    def test_owner_disappearing_is_attention_not_completion(self):
        directory=self.package('orphan')
        result,_=self.wait([directory],20,lambda _:self.live.discard(101))
        self.assertEqual(result['reason'],'any_ready')
        observation=result['observations'][0]
        self.assertEqual(observation['status'],'needs_attention')
        self.assertEqual(observation['reason'],'owner_gone_reconcile_original')
        inspected=reader.inspect_after_wait(directory)
        self.assertEqual(inspected['state'],'owner_gone_reconcile_original')
        self.assertEqual(inspected['taskAcceptance'],'unverified')

    def test_queued_local_is_pending_until_owner_is_gone(self):
        directory=self.package('queued','queued_local')
        result,_=self.wait([directory],1)
        self.assertEqual(result['reason'],'timeout')
        self.assertEqual(result['observations'][0]['status'],'pending')
        self.live.clear()
        result,_=self.wait([directory],1)
        self.assertEqual(result['observations'][0]['reason'],'owner_gone_reconcile_original')

    def test_terminal_receipt_waits_for_launcher_exit(self):
        directory=self.package('finishing','turn_completed',exitCode=0)
        result,clock=self.wait([directory],20,lambda _:self.live.discard(101))
        self.assertEqual(clock.now,1)
        self.assertEqual(result['observations'][0]['status'],'ready')
        self.assertFalse(result['claimReleaseVerified'])
        self.assertEqual(reader.inspect_after_wait(directory)['taskAcceptance'],'unverified')

    def test_terminal_live_launcher_at_timeout_is_explicit(self):
        directory=self.package('still-settling','turn_completed',exitCode=0)
        result,_=self.wait([directory],1)
        self.assertEqual(result['reason'],'timeout')
        self.assertEqual(result['observations'][0]['reason'],'launcher_finishing')
        self.assertFalse(result['claimReleaseVerified'])

    def test_half_written_receipt_can_become_valid_without_full_inspection(self):
        directory=self.package('half')
        (directory/'execution.json').write_text('{"state":',encoding='utf8')
        def finish(_):
            self.receipt(directory,'turn_completed',999,exitCode=0)
        with patch.object(reader,'inspect') as inspect,patch.object(reader,'native_evidence') as evidence:
            result,clock=self.wait([directory],20,finish)
        self.assertEqual(clock.sleeps,[0.25])
        self.assertEqual(result['observations'][0]['status'],'ready')
        inspect.assert_not_called();evidence.assert_not_called()

    def test_persistent_malformed_or_missing_receipt_has_bounded_probes(self):
        for name,raw in (('malformed','{'),('missing',None),('deep','['*1500+'0'+']'*1500),('large',' '*65537)):
            with self.subTest(name=name):
                directory=self.root/name;directory.mkdir()
                if raw is not None:(directory/'execution.json').write_text(raw,encoding='utf8')
                result,clock=self.wait([directory],30)
                self.assertEqual(clock.sleeps,[0.25,0.25])
                self.assertEqual(result['observations'][0]['status'],'needs_attention')
                self.assertEqual(result['observations'][0]['reason'],'execution_metadata_unavailable')
                self.assertEqual(reader.inspect_after_wait(directory)['state'],'unknown_reconcile_original')

    def test_unknown_state_or_owner_needs_review_without_replay(self):
        unknown=self.package('unknown','new_unrecognized_state')
        missing_owner=self.package('owner','running',None)
        for directory in (unknown,missing_owner):
            result,clock=self.wait([directory],20)
            self.assertEqual(clock.sleeps,[])
            self.assertEqual(result['observations'][0]['status'],'needs_attention')
            self.assertEqual(result['modelSends'],0)

    def test_multi_directory_output_uses_existing_inspection_once_each(self):
        first=self.package('done','turn_completed',999,exitCode=0)
        second=self.package('active',pid=202)
        with patch.object(reader,'inspect',wraps=reader.inspect) as inspect:
            result=self.cli([str(first),str(second),'--wait-seconds','10'])
        self.assertEqual(set(result),{'packages','wait'})
        self.assertEqual(inspect.call_count,2)
        self.assertEqual([value['state'] for value in result['packages']],['turn_completed','running'])
        self.assertTrue(all(value['taskAcceptance']=='unverified' for value in result['packages']))

    def test_real_cli_reads_synthetic_packages_and_returns_one_json_document(self):
        first=self.package('cli-done','turn_completed',999999999,exitCode=0)
        second=self.package('cli-active',pid=os.getpid())
        original={path:(path/'execution.json').read_bytes() for path in (first,second)}
        result=subprocess.run([sys.executable,'-B',str(Path(reader.__file__)),str(first),str(second),'--wait-seconds','1'],
                              capture_output=True,encoding='utf8',timeout=5,
                              creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,0,result.stderr)
        output=json.loads(result.stdout)
        self.assertEqual(output['wait']['reason'],'any_ready')
        self.assertEqual([value['state'] for value in output['packages']],['turn_completed','running'])
        for path,raw in original.items():self.assertEqual((path/'execution.json').read_bytes(),raw)

    def test_failed_package_also_returns_while_another_is_pending(self):
        failed=self.package('failed','needs_attention',999,exitCode=1)
        active=self.package('still-active',pid=202)
        result,clock=self.wait([failed,active],20)
        self.assertEqual(clock.sleeps,[])
        self.assertEqual(result['readyResultDirectories'],[str(failed)])
        self.assertEqual(reader.inspect_after_wait(failed)['state'],'needs_attention')

    def test_single_wait_adds_metadata_without_claiming_acceptance(self):
        directory=self.package('single','turn_completed',999,exitCode=0)
        result=self.cli([str(directory),'--wait-seconds','1'])
        self.assertNotIn('packages',result)
        self.assertEqual(result['state'],'turn_completed')
        self.assertIn('wait',result)
        self.assertEqual(result['taskAcceptance'],'unverified')

    def test_legacy_single_directory_json_is_unchanged(self):
        directory=self.package('legacy','completed',999,exitCode=0)
        expected=reader.inspect(str(directory))
        with patch.object(reader,'wait_for_packages') as wait:
            result=self.cli([str(directory)])
        wait.assert_not_called()
        self.assertEqual(result,expected)
        self.assertNotIn('wait',result)

    def test_zero_wait_multi_directory_is_one_snapshot(self):
        directories=[self.package('one'),self.package('two')]
        with patch.object(reader.time,'sleep') as sleep:
            result=self.cli([str(path) for path in directories])
        sleep.assert_not_called()
        self.assertEqual(result['wait']['reason'],'snapshot')
        self.assertEqual(len(result['packages']),2)

    def test_no_progress_is_printed_while_waiting(self):
        directory=self.package('silent')
        output=io.StringIO()
        with contextlib.redirect_stdout(output):self.wait([directory],2)
        self.assertEqual(output.getvalue(),'')

    def test_empty_duplicate_paths_and_invalid_wait_are_cli_errors(self):
        directory=self.package('valid')
        cases=[[],[''],['  '],[str(directory),str(directory/'..'/'valid')]]
        cases.extend([str(directory),'--wait-seconds',value] for value in ('-1','86401','nan','inf','-inf','bad'))
        for arguments in cases:
            with self.subTest(arguments=arguments),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:reader.main(arguments)
                self.assertEqual(error.exception.code,2)
        with self.assertRaises(ValueError):reader.wait_for_packages([],1)

    def test_multi_or_waiting_actions_are_rejected_without_writes(self):
        first=self.package('action-one');second=self.package('action-two')
        with patch.object(reader,'settle_admission') as settle,patch.object(reader,'recover_admission') as recover:
            for flag in ('--settle-admission','--recover-admission'):
                for arguments in ([str(first),str(second),flag],[str(first),flag,'--wait-seconds','1']):
                    with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):reader.main(arguments)
        settle.assert_not_called();recover.assert_not_called()

    def test_legacy_single_settle_action_is_still_explicit(self):
        directory=self.package('settle','turn_completed',999,exitCode=0,admissionId='original')
        with patch.object(reader,'admission_status',return_value={'state':'released'}),patch.object(reader,'settle_admission',return_value={'state':'released'}) as settle:
            result=self.cli([str(directory),'--settle-admission'])
        settle.assert_called_once()
        self.assertEqual(result['admissionSettle'],{'state':'released'})
        self.assertNotIn('wait',result)

    def test_legacy_single_missing_receipt_recover_contract_is_preserved(self):
        directory=self.root/'recover';directory.mkdir()
        with patch.object(reader,'admission_status',return_value={'state':'released'}),patch.object(reader,'recover_admission',return_value={'state':'released'}) as recover:
            result=self.cli([str(directory),'--recover-admission'])
        recover.assert_called_once()
        self.assertEqual(result['modelSends'],0)
        self.assertNotIn('wait',result)


if __name__=='__main__':unittest.main()
