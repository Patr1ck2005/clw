"""Offline native-maintenance safety tests in disposable owned directories."""
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack, closing, redirect_stdout
from io import StringIO
import json
import sqlite3
import sys
import tempfile
import time
import unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
import native_maintenance as m
from live_transport import ObservationError
from product_runtime import atomic_json,read_json,FileLease,ProductError

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.local').mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(prefix='native-maintenance-test-',dir=ROOT/'.local')
        self.root=Path(self.tmp.name).resolve();self.target=self.root/'installed';self.target.mkdir()
        self.source=self.root/'candidate';self.source.mkdir();self.data=self.root/'runtime/data';self.data.mkdir(parents=True)
        self.desktop=self.target/'WebCodex.exe';self.desktop.write_bytes(b'test desktop, never executed')
        self.env=self.root/'original.env';self.env.write_text('original configuration, no actual secret',encoding='utf-8')
        self.connection=self.root/'connection.json';self.connection.write_text('{}',encoding='utf-8')
        self.runner_config=self.root/'runner.toml';self.runner_config.write_text('original runner configuration',encoding='utf-8')
        with closing(sqlite3.connect(self.data/'webcodex.db')) as db, db:
            for name in m.COMMUNICATION_TABLES:db.execute('CREATE TABLE '+name+' (id TEXT)')
        (self.data/'sessions.json').write_text('{"original":"session"}',encoding='utf-8')
        (self.data/'private').mkdir();(self.data/'private/cold-record.json').write_text('{"retain":true}',encoding='utf-8')
        binaries={}
        for name in m.NAMES:
            (self.target/name).write_bytes(('old '+name).encode());(self.source/name).write_bytes(('new '+name).encode())
            binaries[name]={'source':str(self.source/name),'old_sha256':m.digest(self.target/name),'new_sha256':m.digest(self.source/name)}
        self.report=self.root/'native-report.json'
        report={'status':'passed','scenario':'empty_legacy_communication','owned_children_stopped':True,
                'native_runtime_without_toolchain_path':True,
                'credential_scenario':'generated_managed_runner_and_user_pat','adapter_sha256':m.digest(ROOT/'scripts/live_transport.py'),
                'kind':'synthetic report for unit guards, not native acceptance',
                'checks':[{'name':name,'passed':True} for name in sorted(m.REQUIRED_CHECKS)],
                'binaries':{'old':{n:{'sha256':v['old_sha256']} for n,v in binaries.items()},
                            'new':{n[:-4]:{'sha256':v['new_sha256']} for n,v in binaries.items()}}}
        atomic_json(self.report,report)
        self.spec={'format':'clw.native-maintenance.v1','install_dir':str(self.target),'desktop_executable':str(self.desktop),
                   'runtime_data':str(self.data),'origin':'http://127.0.0.1:12345','client_id':'test-maintenance',
                   'connection_config':str(self.connection),'unchanged_files':{str(p):m.digest(p) for p in (self.env,self.runner_config,self.desktop)},
                   'binaries':binaries,'native_report':str(self.report)}
        self.specfile=self.root/'spec.json';atomic_json(self.specfile,self.spec);self.stage=self.root/'stage'
        self.stack=ExitStack();self.stack.enter_context(patch.object(m,'runtime_processes',return_value=[]));self.stack.enter_context(patch.object(m,'port_busy',return_value=False))
    def tearDown(self):self.stack.close();self.tmp.cleanup()
    def prepare(self):return m.prepare(self.specfile,self.stage)
    def armed(self):
        self.prepare();self.runtime={'focus':{'client_id':self.spec['client_id'],'connected':True,'build':{'git_commit':m.OLD}},
                                    'server':{'build':{'git_commit':m.OLD,'git_dirty':False}},
                                    'jobs':{'active_count':0,'running_count':0,'queued_count':0}}
        self.jobs={'jobs':[{'job_id':'original-job','status':'completed','exit_code':0,'project':'original','session_id':'original-session'}],'truncated':False,'matched_count':1}
        class Transport:
            origin=self.spec['origin'];client_id=self.spec['client_id']
            def post(inner,operation,payload,deadline):return self.runtime if operation=='status' else self.jobs
        self.transport=Transport();self.stack.enter_context(patch.object(m,'configuration',return_value=self.transport));m.arm(self.stage)
    def test_prepare_never_touches_installed_code_or_data(self):
        before=m.tree_hashes(self.data);result=self.prepare();self.assertFalse(result['installed']);self.assertEqual(result['tunnels_created'],0)
        self.assertEqual(m.tree_hashes(self.data),before)
        for name,v in self.spec['binaries'].items():self.assertEqual(m.digest(self.target/name),v['old_sha256'])
    def test_nonempty_legacy_communication_blocks_prepare(self):
        with closing(sqlite3.connect(self.data/'webcodex.db')) as db, db:db.execute("INSERT INTO wc_conversations VALUES ('original')")
        with self.assertRaisesRegex(ProductError,'legacy_communication'):self.prepare()
        self.assertFalse(self.stage.exists())
    def test_incomplete_native_acceptance_is_not_release_evidence(self):
        value=read_json(self.report);value['checks']=[];atomic_json(self.report,value)
        with self.assertRaises(ProductError):self.prepare()
    def test_other_credential_scenario_is_not_managed_acceptance(self):
        value=read_json(self.report);value['credential_scenario']='shared';atomic_json(self.report,value)
        with self.assertRaises(ProductError):self.prepare()
    def test_changed_candidate_or_baseline_is_not_overwritten(self):
        (self.target/m.NAMES[0]).write_bytes(b'unknown version')
        with self.assertRaisesRegex(ProductError,'installed_binary_changed'):self.prepare()
        self.assertEqual((self.target/m.NAMES[0]).read_bytes(),b'unknown version')
    def test_existing_stage_is_not_replayed(self):
        self.prepare()
        with self.assertRaises(ProductError):self.prepare()
    def test_staged_tampering_blocks_every_action(self):
        self.prepare();(self.stage/'new'/m.NAMES[0]).write_bytes(b'tampered')
        with self.assertRaises(ProductError):m.stage(self.stage)
    def test_invalid_operation_id_cannot_escape_backup_parent(self):
        self.prepare();record=read_json(self.stage/'operation.json');record['id']='../'+'x'*29;atomic_json(self.stage/'operation.json',record)
        with self.assertRaises(ProductError):m.stage(self.stage)
    def test_armed_snapshot_archives_actual_original_job_metadata(self):
        self.armed();archive=read_json(self.stage/'original-jobs.json');self.assertEqual(archive['jobs'][0]['job_id'],'original-job');self.assertEqual(archive['jobs'][0]['exit_code'],0)
    def test_active_jobs_block_arm_without_stopping_them(self):
        self.armed();self.runtime['jobs']['active_count']=1
        with self.assertRaisesRegex(ProductError,'active_or_unknown'):m.arm(self.stage)
        self.assertNotIn('armed_at',read_json(self.stage/'operation.json'))
        with self.assertRaisesRegex(ProductError,'fresh_zero_job'):m.install(self.stage,True)
    def test_missing_job_count_is_unknown_not_zero(self):
        self.armed();del self.runtime['jobs']['queued_count']
        with self.assertRaises(ProductError):m.arm(self.stage)
    def test_partial_original_job_list_blocks_arm(self):
        self.armed();self.jobs['truncated']=True
        with self.assertRaises(ProductError):m.arm(self.stage)
    def test_wrong_runner_identity_blocks_arm(self):
        self.armed();self.runtime['focus']['client_id']='other'
        with self.assertRaises(ProductError):m.arm(self.stage)
    def test_expired_or_future_zero_job_receipt_blocks_install(self):
        self.armed()
        for stamp in (time.time()-m.MAX_AGE-5,time.time()+10):
            record=read_json(self.stage/'operation.json');record['armed_at']=stamp;atomic_json(self.stage/'operation.json',record)
            with self.assertRaisesRegex(ProductError,'fresh_zero_job'):m.install(self.stage,True)
    def test_explicit_offline_confirmation_required(self):
        self.armed()
        with self.assertRaises(ProductError):m.install(self.stage,False)
    def test_original_desktop_still_running_blocks_install(self):
        self.armed()
        with patch.object(m,'runtime_processes',return_value=[{'ExecutablePath':str(self.desktop),'ProcessId':123}]):
            with self.assertRaisesRegex(ProductError,'still_running'):m.install(self.stage,True)
    def test_unknown_process_path_blocks_install(self):
        self.armed()
        with patch.object(m,'runtime_processes',return_value=[{'ExecutablePath':None,'ProcessId':123}]):
            with self.assertRaises(ProductError):m.install(self.stage,True)
    def test_occupied_port_blocks_install(self):
        self.armed()
        with patch.object(m,'port_busy',return_value=True):
            with self.assertRaises(ProductError):m.install(self.stage,True)
    def test_native_kernel_lock_blocks_install(self):
        self.armed()
        with FileLease(self.data/'webcodex.db.server-instance.lock'):
            with self.assertRaises(ProductError):m.install(self.stage,True)
    def test_new_legacy_record_after_staging_blocks_install(self):
        self.armed()
        with closing(sqlite3.connect(self.data/'webcodex.db')) as db, db:db.execute("INSERT INTO wc_agent_wakes VALUES ('late')")
        with self.assertRaisesRegex(ProductError,'legacy_communication'):m.install(self.stage,True)
    def test_offline_install_preserves_exact_data_and_config(self):
        self.armed();before=m.tree_hashes(self.data);result=m.install(self.stage,True)
        self.assertEqual(result['phase'],'installed_not_started');self.assertEqual(m.tree_hashes(self.data),before)
        self.assertEqual(m.tree_hashes(Path(result['backup'])),before)
        for name,v in self.spec['binaries'].items():self.assertEqual(m.digest(self.target/name),v['new_sha256'])
        self.assertFalse(result['services_started'])
    def test_partial_pair_requires_original_reconciliation_not_reinstall(self):
        self.armed();original=m.atomic_copy;counter=0
        def failure(source,target):
            nonlocal counter
            counter+=1
            if counter==2:raise OSError('controlled second-file failure')
            original(source,target)
        with patch.object(m,'atomic_copy',side_effect=failure):
            with self.assertRaises(OSError):m.install(self.stage,True)
        self.assertEqual(read_json(self.stage/'operation.json')['phase'],'installation_interrupted_reconcile')
        with self.assertRaises(ProductError):m.install(self.stage,True)
        result=m.recover_code(self.stage,True);self.assertEqual(result['phase'],'old_code_restored')
        for name,v in self.spec['binaries'].items():self.assertEqual(m.digest(self.target/name),v['old_sha256'])
    def test_recovery_never_overwrites_data_changed_after_start(self):
        self.armed();m.install(self.stage,True);(self.data/'sessions.json').write_text('{"new":"accepted work"}')
        with self.assertRaisesRegex(ProductError,'new_runtime_data_exists'):m.recover_code(self.stage,True)
        self.assertIn('accepted work',(self.data/'sessions.json').read_text())
        self.assertEqual(m.digest(self.target/m.NAMES[0]),self.spec['binaries'][m.NAMES[0]]['new_sha256'])
    def test_modified_original_config_blocks_later_install(self):
        self.armed();self.runner_config.write_text('user changed configuration')
        with self.assertRaisesRegex(ProductError,'configuration_changed'):m.install(self.stage,True)

    def test_write_access_is_proved_before_arm(self):
        self.prepare()
        with patch.object(m,'verify_install_write_access',side_effect=ProductError('administrator_or_install_write_access_required_before_arming')),patch.object(m,'arm',side_effect=AssertionError('must not arm without install authority')),patch('sys.stdin.isatty',return_value=True),redirect_stdout(StringIO()):
            with self.assertRaisesRegex(ProductError,'administrator_or_install_write_access_required_before_arming'):m.assist(self.stage)
        self.assertEqual(read_json(self.stage/'operation.json')['phase'],'prepared')

    def test_old_code_restored_can_create_new_independent_attempt(self):
        self.armed();m.install(self.stage,True);old_id=read_json(self.stage/'operation.json')['id'];m.recover_code(self.stage,True)
        result=m.reprepare_after_restore(self.stage);record=read_json(self.stage/'operation.json')
        self.assertEqual(result['phase'],'prepared');self.assertNotEqual(record['id'],old_id)
        self.assertEqual(record['previous_operation_id'],old_id)
        self.assertTrue((self.stage/'operation-history'/(old_id+'.json')).is_file())
        self.assertEqual(read_json(self.stage/'operation-history'/(old_id+'.json'))['phase'],'old_code_restored')

    def test_reprepare_after_restore_rejects_new_legacy_communication(self):
        self.armed();m.install(self.stage,True);m.recover_code(self.stage,True)
        with closing(sqlite3.connect(self.data/'webcodex.db')) as db, db:db.execute("INSERT INTO wc_conversations VALUES ('new-old-runtime-record')")
        with self.assertRaisesRegex(ProductError,'legacy_communication'):m.reprepare_after_restore(self.stage)

    def test_assist_resumes_same_fresh_offline_window_without_rearming(self):
        self.armed();archive=(self.stage/'original-jobs.json').read_bytes()
        with patch('sys.stdin.isatty',return_value=True),patch('builtins.input',return_value='UPGRADE'),patch.object(m,'arm',side_effect=AssertionError('closed Server must not be queried again')),redirect_stdout(StringIO()):
            result=m.assist(self.stage)
        self.assertEqual(result['phase'],'installed_not_started');self.assertEqual((self.stage/'original-jobs.json').read_bytes(),archive)
    def test_assist_expired_offline_window_does_not_install(self):
        self.armed();record=read_json(self.stage/'operation.json');record['armed_at']=time.time()-m.MAX_AGE-1;atomic_json(self.stage/'operation.json',record)
        with patch('sys.stdin.isatty',return_value=True),patch('builtins.input',return_value='UPGRADE'),patch.object(m,'arm',side_effect=ObservationError('upstream_unreachable')),redirect_stdout(StringIO()):
            with self.assertRaises(ObservationError):m.assist(self.stage)
        self.assertEqual(m.digest(self.target/m.NAMES[0]),self.spec['binaries'][m.NAMES[0]]['old_sha256'])
    def test_assist_cancel_never_changes_original_receipt(self):
        self.armed();before=(self.stage/'operation.json').read_bytes()
        with patch('sys.stdin.isatty',return_value=True),patch('builtins.input',return_value='NO'),redirect_stdout(StringIO()):
            with self.assertRaisesRegex(ProductError,'not_confirmed'):m.assist(self.stage)
        self.assertEqual((self.stage/'operation.json').read_bytes(),before)
    def test_assist_already_installed_never_replays(self):
        self.armed();m.install(self.stage,True);before=(self.stage/'operation.json').read_bytes()
        with patch('sys.stdin.isatty',return_value=True),patch.object(m,'install',side_effect=AssertionError('must not reinstall')),patch('builtins.input',side_effect=AssertionError('no new authorization needed')),redirect_stdout(StringIO()):
            result=m.assist(self.stage)
        self.assertFalse(result['replayed']);self.assertEqual((self.stage/'operation.json').read_bytes(),before)
    def test_wait_offline_allows_normal_delayed_exit(self):
        with patch.object(m,'offline',side_effect=[ProductError('original_runtime_still_running_no_process_stopped'),ProductError('original_port_still_occupied_no_process_stopped'),None]) as call,patch.object(m.time,'sleep'):
            m.wait_offline(self.spec)
        self.assertEqual(call.call_count,3)
    def test_wait_offline_never_retries_unknown_process_identity(self):
        with patch.object(m,'offline',side_effect=ProductError('native_process_identity_unknown')) as call,patch.object(m.time,'sleep') as sleep:
            with self.assertRaises(ProductError):m.wait_offline(self.spec)
        self.assertEqual(call.call_count,1);sleep.assert_not_called()
    def test_main_reports_unreachable_runtime_without_traceback_or_old_permit(self):
        self.armed()
        with patch.object(self.transport,'post',side_effect=ObservationError('upstream_unreachable')),patch('sys.argv',['native_maintenance.py','arm','--stage',str(self.stage)]),redirect_stdout(StringIO()) as output:
            self.assertEqual(m.main(),1)
        self.assertEqual(json.loads(output.getvalue())['error'],'upstream_unreachable');self.assertNotIn('armed_at',read_json(self.stage/'operation.json'))
    def test_main_input_eof_retains_original_prepared_operation(self):
        self.prepare();before=(self.stage/'operation.json').read_bytes()
        with patch('sys.argv',['native_maintenance.py','assist','--stage',str(self.stage)]),patch('sys.stdin.isatty',return_value=True),patch('builtins.input',side_effect=EOFError),redirect_stdout(StringIO()) as output:
            self.assertEqual(m.main(),130)
        self.assertEqual((self.stage/'operation.json').read_bytes(),before);self.assertIn('operator_interrupted',output.getvalue())


    def test_write_probe_cleans_up_and_does_not_change_operation(self):
        self.prepare();before=(self.stage/'operation.json').read_bytes()
        m.verify_install_write_access(self.spec)
        self.assertEqual((self.stage/'operation.json').read_bytes(),before)
        self.assertFalse(any(self.target.glob('.clw-maintenance-write-probe-*')))

    def test_root_launcher_requests_elevation_before_python(self):
        text=(ROOT/'MAINTAIN_EXISTING_MCP.cmd').read_text(encoding='utf-8')
        self.assertLess(text.index('fltmc'),text.index('python -X utf8'))
        self.assertIn('Start-Process',text);self.assertIn('-Verb RunAs',text)

if __name__=='__main__':unittest.main(verbosity=2)
