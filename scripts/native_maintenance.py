"""Existing-ingress native maintenance; never creates a Tunnel or edits credentials.

Staging is safe while the original runtime operates. Installation requires an
explicit offline maintenance window, a fresh complete zero-Job observation and
the native database lock. Unknown/partially applied operations are reconciled,
not replayed. Post-start data is never rolled back automatically.
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from contextlib import closing
import argparse
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from product_runtime import FileLease, ProductError, atomic_json, read_json
from task_worker import linked
from live_transport import configuration, validate_origin, ObservationError

ROOT = Path(__file__).resolve().parents[1]
NAMES = ('webcodex-server.exe', 'webcodex-runner.exe')
OLD = 'f080c8f3ea70'
NEW = '37098d4624f0'
COMMUNICATION_TABLES = ('wc_agent_identities','wc_agent_endpoints','wc_conversations',
                        'wc_conversation_participants','wc_conversation_messages',
                        'wc_agent_deliveries','wc_agent_wakes','wc_agent_wake_attempts')
MAX_AGE = 300
REQUIRED_CHECKS = {'new_server_new_runner_same_session','new_server_new_runner_old_file_read',
                   'product_observer_accepts_paired_upgrade','new_server_exposes_direct_app',
                   'new_communication_operates_after_existing_session_upgrade','backup_unchanged',
                   'restored_old_server_old_runner_same_session','new_data_not_deleted_by_rollback_rehearsal',
                   'isolated_managed_runner_and_user_pat_created','maintenance_kernel_lock_blocks_real_native_server'}


def fail(code):
    raise ProductError(code)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def plain(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or any(part in ('.', '..') for part in path.parts):
        fail('explicit_absolute_path_required')
    for p in (path, *path.parents):
        if p.exists() and linked(p):
            fail('linked_maintenance_path_rejected')
    if not (path.is_dir() if directory else path.is_file()):
        fail('maintenance_path_unavailable')
    return path.resolve()


def port_busy(origin):
    port = int(validate_origin(origin).rsplit(':', 1)[1])
    with socket.socket() as sock:
        sock.settimeout(.5)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def runtime_processes():
    if os.name != 'nt':
        fail('windows_maintenance_only')
    command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('webcodex-server.exe','webcodex-runner.exe','WebCodex.exe')} | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress"
    value = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],capture_output=True,text=True,encoding='utf-8',errors='strict',timeout=15)
    if value.returncode:
        fail('process_observation_unavailable')
    rows = json.loads(value.stdout) if value.stdout.strip() else []
    return rows if isinstance(rows, list) else [rows]


def offline(spec):
    expected = {os.path.normcase(str(Path(spec['install_dir']) / name)) for name in NAMES}
    expected.add(os.path.normcase(spec['desktop_executable']))
    for process in runtime_processes():
        # An inaccessible relevant process is unknown, never assumed safe.
        path = process.get('ExecutablePath')
        if not isinstance(path, str):
            fail('native_process_identity_unknown')
        if os.path.normcase(path) in expected:
            fail('original_runtime_still_running_no_process_stopped')
    if port_busy(spec['origin']):
        fail('original_port_still_occupied_no_process_stopped')


def communication_counts(data):
    path = plain(Path(data) / 'webcodex.db')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            fail('native_database_integrity_failed')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {'wc_agent_identities','wc_conversations','wc_conversation_messages','wc_agent_wakes'}
        if not required <= tables:
            fail('native_database_schema_not_recognized')
        return {name:db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in COMMUNICATION_TABLES if name in tables}


def tree_hashes(root):
    root = plain(root, directory=True)
    result = {}; total = 0
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            plain(Path(folder) / name, directory=True)
        for name in files:
            p = plain(Path(folder) / name)
            if p.name.endswith('.server-instance.lock'):
                continue
            total += p.stat().st_size
            if total > 2 * 1024**3 or len(result) >= 10000:
                fail('native_backup_bound_exceeded')
            result[p.relative_to(root).as_posix()] = digest(p)
    if 'webcodex.db' not in result or 'sessions.json' not in result:
        fail('native_data_missing_original_sessions')
    return result


def load_spec(path):
    spec = read_json(plain(path), 65536)
    fields = {'format','install_dir','desktop_executable','runtime_data','origin','client_id',
              'connection_config','unchanged_files','binaries','native_report'}
    if not isinstance(spec, dict) or set(spec) != fields or spec['format'] != 'clw.native-maintenance.v1':
        fail('invalid_native_maintenance_spec')
    plain(spec['install_dir'], True); plain(spec['desktop_executable']); plain(spec['runtime_data'], True)
    plain(spec['connection_config']); validate_origin(spec['origin'])
    if not isinstance(spec['client_id'], str) or not spec['client_id']:
        fail('exact_runner_required')
    if set(spec['binaries']) != set(NAMES):
        fail('paired_native_binaries_required')
    for name, entry in spec['binaries'].items():
        if set(entry) != {'old_sha256','new_sha256','source'}:
            fail('invalid_binary_spec')
        for key in ('old_sha256','new_sha256'):
            if not isinstance(entry[key],str) or len(entry[key]) != 64 or any(c not in '0123456789abcdef' for c in entry[key]):
                fail('invalid_binary_hash')
        plain(entry['source'])
    if not isinstance(spec['unchanged_files'], dict) or not 2 <= len(spec['unchanged_files']) <= 12:
        fail('explicit_preserved_configuration_required')
    for name, expected in spec['unchanged_files'].items():
        if digest(plain(name)) != expected:
            fail('original_configuration_changed')
    return spec


def verify_source(spec):
    report = read_json(plain(spec['native_report']))
    if (report.get('status') != 'passed' or report.get('scenario') != 'empty_legacy_communication'
            or report.get('owned_children_stopped') is not True
            or report.get('credential_scenario') != 'generated_managed_runner_and_user_pat'
            or not report.get('checks') or not all(c.get('passed') is True for c in report['checks'])):
        fail('paired_managed_native_acceptance_required')
    if report.get('native_runtime_without_toolchain_path') is not True:
        fail('native_runtime_standalone_acceptance_required')
    if not REQUIRED_CHECKS <= {c.get('name') for c in report['checks']}:
        fail('native_acceptance_checks_incomplete')
    if report.get('adapter_sha256') != digest(ROOT/'scripts/live_transport.py'):
        fail('native_acceptance_adapter_changed')
    for name, entry in spec['binaries'].items():
        if digest(entry['source']) != entry['new_sha256']:
            fail('candidate_binary_changed')
        native = report['binaries']['new'][name[:-4]]
        if native['sha256'] != entry['new_sha256']:
            fail('candidate_not_the_tested_binary')
        if report['binaries']['old'][name]['sha256'] != entry['old_sha256']:
            fail('installed_baseline_not_tested')
    return report


def prepare(spec_path, destination):
    spec = load_spec(spec_path); verify_source(spec)
    destination = Path(destination)
    if destination.exists():
        fail('maintenance_stage_exists_reconcile_original')
    plain(destination.parent, True)
    counts = communication_counts(spec['runtime_data'])
    if any(counts.values()):
        fail('legacy_communication_requires_explicit_migration')
    for name, entry in spec['binaries'].items():
        if digest(plain(Path(spec['install_dir']) / name)) != entry['old_sha256']:
            fail('installed_binary_changed')
    destination.mkdir()
    for group in ('old', 'new'):
        (destination / group).mkdir()
        for name, entry in spec['binaries'].items():
            source = Path(spec['install_dir']) / name if group == 'old' else Path(entry['source'])
            shutil.copyfile(source, destination / group / name)
            if digest(destination / group / name) != entry[group + '_sha256']:
                fail('staged_copy_mismatch')
    atomic_json(destination / 'spec.json', spec)
    atomic_json(destination / 'operation.json', {'format':'clw.native-maintenance-operation.v1',
                'id':uuid.uuid4().hex,'phase':'prepared','tunnels_created':0,'services_stopped':False})
    return {'stage':str(destination),'phase':'prepared','installed':False,'data_copied':False,'tunnels_created':0}


def stage(path):
    path = plain(path, True)
    spec = load_spec(path / 'spec.json'); record = read_json(path / 'operation.json')
    if (record.get('format') != 'clw.native-maintenance-operation.v1'
            or not isinstance(record.get('id'),str) or len(record['id']) != 32
            or any(c not in '0123456789abcdef' for c in record['id'])):
        fail('maintenance_receipt_invalid')
    for group in ('old', 'new'):
        for name, entry in spec['binaries'].items():
            if digest(plain(path / group / name)) != entry[group + '_sha256']:
                fail('staged_binary_changed')
    return path, spec, record


def verify_install_write_access(spec):
    """Prove target-directory write authority before arming or stopping runtime."""
    directory = plain(spec['install_dir'], True)
    probe = directory / ('.clw-maintenance-write-probe-' + uuid.uuid4().hex + '.tmp')
    try:
        with probe.open('xb') as stream:
            stream.write(b'clw-maintenance-write-probe')
            stream.flush(); os.fsync(stream.fileno())
    except PermissionError:
        fail('administrator_or_install_write_access_required_before_arming')
    except OSError:
        fail('install_write_access_unavailable_before_arming')
    finally:
        if probe.exists():
            try:
                probe.unlink()
            except OSError:
                fail('install_write_probe_cleanup_failed')


def arm(path):
    path = plain(path, True)
    with FileLease(path/'.maintenance.lock'):
        return _arm_locked(path)


def _arm_locked(path):
    path, spec, record = stage(path)
    if record['phase'] != 'prepared':
        fail('original_operation_requires_reconciliation')
    # A newly observed active/unknown Job must invalidate any earlier permit.
    record.pop('armed_at', None); record.pop('original_jobs_sha256', None)
    atomic_json(path/'operation.json', record)
    transport = configuration(Path(spec['connection_config']))
    if transport is None or transport.origin != spec['origin'] or transport.client_id != spec['client_id']:
        fail('existing_connection_identity_changed')
    runtime = transport.post('status', {'compact':True,'client_id':spec['client_id']}, time.monotonic()+12)
    focus = runtime.get('focus', {})
    server_build = runtime.get('build') or runtime.get('server',{}).get('build',{})
    if (focus.get('client_id') != spec['client_id'] or focus.get('connected') is not True
            or server_build.get('git_commit') != OLD or server_build.get('git_dirty') is not False
            or focus.get('build',{}).get('git_commit') != OLD):
        fail('current_runtime_is_not_the_reviewed_baseline')
    counts = runtime.get('jobs',{})
    if any(type(counts.get(k)) is not int or counts[k] != 0 for k in ('active_count','running_count','queued_count')):
        fail('active_or_unknown_jobs_no_update')
    jobs = transport.post('jobs', {'limit':100}, time.monotonic()+12)
    rows = jobs.get('jobs')
    if (not isinstance(rows,list) or jobs.get('truncated') is not False or jobs.get('matched_count') != len(rows)
            or any(row.get('status') not in {'completed','failed','cancelled'} for row in rows)):
        fail('incomplete_or_unsettled_original_jobs')
    archive = {'observed_at':time.time(),'origin':spec['origin'],'client_id':spec['client_id'],
               'jobs':[{'job_id':row.get('job_id'),'status':row.get('status'),'exit_code':row.get('exit_code'),
                        'project':row.get('project'),'session_id':row.get('session_id')} for row in rows],
               'source':'original_runtime_metadata_not_a_replacement_native_receipt'}
    atomic_json(path/'original-jobs.json', archive)
    record.update(armed_at=time.time(), original_jobs_sha256=digest(path/'original-jobs.json'))
    atomic_json(path/'operation.json',record)
    return {'phase':'armed_for_offline_window','original_jobs_archived':len(rows),'services_stopped':False}


def atomic_copy(source, target):
    temporary = target.with_name(target.name + '.clw-' + uuid.uuid4().hex + '.tmp')
    try:
        with source.open('rb') as src, temporary.open('xb') as dst:
            shutil.copyfileobj(src, dst, 1024*1024); dst.flush(); os.fsync(dst.fileno())
        if digest(temporary) != digest(source):fail('installation_copy_mismatch')
        os.replace(temporary, target)
    finally:
        if temporary.exists():temporary.unlink()


def install(path, confirm):
    if confirm is not True:fail('explicit_offline_maintenance_confirmation_required')
    path, spec, record = stage(path)
    with FileLease(path/'.maintenance.lock'):
        path, spec, record = stage(path)
        if record['phase'] != 'prepared':fail('original_operation_requires_reconciliation')
        armed = record.get('armed_at')
        if type(armed) not in (int,float) or not 0 <= time.time()-armed <= MAX_AGE:
            fail('fresh_zero_job_observation_required')
        if digest(plain(path/'original-jobs.json')) != record.get('original_jobs_sha256'):
            fail('original_job_archive_changed')
        offline(spec)
        data = Path(spec['runtime_data']); lock = data/'webcodex.db.server-instance.lock'
        with FileLease(lock):
            if any(communication_counts(data).values()):fail('legacy_communication_requires_explicit_migration')
            for name, entry in spec['binaries'].items():
                if digest(plain(Path(spec['install_dir'])/name)) != entry['old_sha256']:
                    fail('installed_binary_changed')
            before = tree_hashes(data)
            # Backups inherit the same Desktop application-data parent as the source.
            backup_parent = data.parent/'clw-native-backups'; backup_parent.mkdir(exist_ok=True)
            plain(backup_parent, True); backup = backup_parent/record['id']
            if backup.exists():fail('original_backup_exists_reconcile')
            backup.mkdir()
            for relative in before:
                target=backup/relative;target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(data/relative,target)
            if tree_hashes(backup) != before or tree_hashes(data) != before:
                fail('offline_backup_changed_or_incomplete')
            record.update(phase='installing',backup=str(backup),data_before=before,replaced=[])
            atomic_json(path/'operation.json',record)
            try:
                for name in NAMES:
                    offline(spec)
                    atomic_copy(path/'new'/name,Path(spec['install_dir'])/name)
                    record['replaced'].append(name);atomic_json(path/'operation.json',record)
                if tree_hashes(data) != before:fail('data_changed_during_offline_install')
                record.update(phase='installed_not_started',installed_at=time.time())
                atomic_json(path/'operation.json',record)
            except BaseException:
                # No blind rollback: preserve the partial pair and original operation.
                # recover-code checks both process state and unchanged data first.
                record['phase']='installation_interrupted_reconcile';atomic_json(path/'operation.json',record)
                raise
    return {'phase':record['phase'],'backup':record['backup'],'services_started':False,'tunnels_created':0}


def recover_code(path, confirm):
    if confirm is not True:fail('explicit_offline_maintenance_confirmation_required')
    path, spec, record = stage(path)
    with FileLease(path/'.maintenance.lock'):
        path, spec, record = stage(path)
        if record['phase'] not in {'installing','installation_interrupted_reconcile','installed_not_started'}:
            fail('no_recoverable_original_installation')
        offline(spec)
        with FileLease(Path(spec['runtime_data'])/'webcodex.db.server-instance.lock'):
            if tree_hashes(spec['runtime_data']) != record.get('data_before'):
                fail('new_runtime_data_exists_preserve_and_review_no_automatic_rollback')
            if tree_hashes(record['backup']) != record['data_before']:
                fail('original_backup_changed')
            for name, entry in spec['binaries'].items():
                if digest(plain(Path(spec['install_dir'])/name)) not in (entry['old_sha256'],entry['new_sha256']):
                    fail('unrecognized_installed_binary_no_overwrite')
            for name in NAMES:atomic_copy(path/'old'/name,Path(spec['install_dir'])/name)
            record.update(phase='old_code_restored',restored_at=time.time());atomic_json(path/'operation.json',record)
    return {'phase':'old_code_restored','data_restored':False,'new_data_deleted':False,'services_started':False}


def reprepare_after_restore(path):
    """Start a new operation only after the prior interrupted install was restored."""
    path = plain(path, True)
    with FileLease(path/'.maintenance.lock'):
        path, spec, record = stage(path)
        if record['phase'] != 'old_code_restored':
            fail('original_operation_requires_reconciliation')
        if any(communication_counts(spec['runtime_data']).values()):
            fail('legacy_communication_requires_explicit_migration')
        for name, entry in spec['binaries'].items():
            if digest(plain(Path(spec['install_dir'])/name)) != entry['old_sha256']:
                fail('installed_binary_changed')
        history = path/'operation-history'
        history.mkdir(exist_ok=True)
        plain(history, True)
        prior = record['id']
        archived = history/(prior+'.json')
        if archived.exists():
            fail('original_operation_history_exists_reconcile')
        atomic_json(archived, record)
        fresh = {'format':'clw.native-maintenance-operation.v1','id':uuid.uuid4().hex,
                 'phase':'prepared','tunnels_created':0,'services_stopped':False,
                 'previous_operation_id':prior}
        atomic_json(path/'operation.json', fresh)
        return {'phase':'prepared','previous_operation_id':prior,'operation_id':fresh['id']}



def wait_offline(spec, timeout=15):
    """Bounded grace for an explicit user-initiated exit; never kills a process."""
    deadline=time.monotonic()+timeout
    while True:
        try:
            offline(spec)
            return
        except ProductError as exc:
            if str(exc) not in {'original_runtime_still_running_no_process_stopped','original_port_still_occupied_no_process_stopped'}:
                raise
            if time.monotonic() >= deadline:
                raise
            time.sleep(.2)


def assist(path):
    if not sys.stdin.isatty():fail('interactive_maintenance_window_required')
    path,spec,record=stage(path)
    if record['phase']=='installed_not_started':
        if any(digest(plain(Path(spec['install_dir'])/name)) != entry['new_sha256'] for name,entry in spec['binaries'].items()):
            fail('installed_pair_changed_reconcile_original')
        print('原配套安装已完成；没有再次安装。请打开原 WebCodex Desktop，随后核对原连接。')
        return {'phase':'installed_not_started','replayed':False,'services_started':False}
    if record['phase']=='old_code_restored':
        verify_install_write_access(spec)
        reset=reprepare_after_restore(path)
        print('上一次中断安装已恢复为旧代码；已保留原操作历史，并创建新的维护尝试 '+reset['operation_id']+'。')
        path,spec,record=stage(path)
    elif record['phase']=='prepared':
        verify_install_write_access(spec)
    else:
        fail('original_operation_requires_reconciliation')
    print('配套更新原 WebCodex Server/Runner；保留原 Tunnel、地址、配置和数据。不会自动停止任何进程。')
    print('请先停止各对话发起新操作，确认原任务均已结束。安装目标：'+spec['install_dir'])
    if input('明确同意此维护窗口请输入 UPGRADE：').strip()!='UPGRADE':fail('maintenance_not_confirmed')
    armed=record.get('armed_at');resume_offline=False
    if type(armed) in (int,float) and 0 <= time.time()-armed <= MAX_AGE:
        try:
            offline(spec);resume_offline=True
        except ProductError as exc:
            if str(exc) not in {'original_runtime_still_running_no_process_stopped','original_port_still_occupied_no_process_stopped'}:
                raise
    if resume_offline:
        print('恢复同一次已核对的离线维护；仍将检查原许可、回执、配置和数据，不重新请求已关闭的Server。')
    else:
        print(json.dumps(arm(path),ensure_ascii=False))
        input('现在从托盘退出 WebCodex Desktop，保持其他对话不发起操作，然后回车。不要删除配置或退出 ChatGPT 账号。')
        wait_offline(spec)
    result=install(path,True)
    print('代码与原数据备份已核验。请打开原 WebCodex Desktop；原 B 隧道若需恢复，仍使用原启动入口。')
    print('新数据启动后的回退需单独核对，绝不自动覆盖新任务记录。')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('prepare');p.add_argument('--spec',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    for name in ('status','arm','install-offline','recover-code-offline','assist'):
        p=sub.add_parser(name);p.add_argument('--stage',type=Path,required=True)
        if name in ('install-offline','recover-code-offline'):p.add_argument('--confirm',action='store_true')
    args=parser.parse_args()
    try:
        if args.command=='prepare':result=prepare(args.spec,args.out)
        elif args.command=='arm':result=arm(args.stage)
        elif args.command=='install-offline':result=install(args.stage,args.confirm)
        elif args.command=='recover-code-offline':result=recover_code(args.stage,args.confirm)
        elif args.command=='status':
            path,spec,record=stage(args.stage);result={'phase':record['phase'],'install_dir':spec['install_dir'],'original_origin':spec['origin'],'legacy_communication_counts':communication_counts(spec['runtime_data']),'services_changed':False}
        else:result=assist(args.stage)
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    except (ProductError,ObservationError,OSError,ValueError,sqlite3.Error,subprocess.SubprocessError) as exc:
        code=str(exc) if isinstance(exc,ProductError) else exc.code if isinstance(exc,ObservationError) else type(exc).__name__
        print(json.dumps({'success':False,'error':code,
                          'automatic_process_stop':False,'automatic_data_rollback':False},ensure_ascii=False));return 1
    except (EOFError,KeyboardInterrupt):
        print(json.dumps({'success':False,'error':'operator_interrupted_original_operation_retained',
                          'automatic_process_stop':False,'automatic_data_rollback':False}));return 130

if __name__=='__main__':
    raise SystemExit(main())
