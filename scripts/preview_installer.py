"""Per-user preview lifecycle; no service stop, account discovery, or model send."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid
import web_workspace_release as release
from product_runtime import FileLease, ProductError, atomic_json

PREVIEW_LAUNCHER=b'''@echo off\r
set "CLW_INSTALL_ROOT=%~dp0."\r
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$r=[IO.Path]::GetFullPath($env:CLW_INSTALL_ROOT); $a=Get-Content -LiteralPath (Join-Path $r 'active.json') -Raw | ConvertFrom-Json; if ($a.build_id -notmatch '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$') {exit 2}; $c=Join-Path (Join-Path $r 'versions') $a.build_id; $p=Join-Path $c 'runtime/python/python.exe'; if (!(Test-Path -LiteralPath $p -PathType Leaf)) {exit 2}; & $p -B (Join-Path $r 'manager/web_workspace_release.py') launch --install-root $r; exit $LASTEXITCODE"\r
'''
PREVIEW_GUI_LAUNCHER=('Set shell = CreateObject("WScript.Shell")\r\n'
    'Set files = CreateObject("Scripting.FileSystemObject")\r\n'
    'shell.Environment("Process")("CLW_INSTALL_ROOT") = files.GetParentFolderName(WScript.ScriptFullName)\r\n'
    'shell.Run "'+PREVIEW_LAUNCHER.decode('ascii').splitlines()[2].replace('"','""')+'", 0, False\r\n').encode('ascii')
MAINTENANCE_LAUNCHER=PREVIEW_LAUNCHER.replace(b"(Join-Path $r 'manager/web_workspace_release.py') launch",b"(Join-Path $c 'scripts/preview_installer.py') menu")

def normalized(value):
    return os.path.abspath(str(value).removeprefix('\\\\?\\')).replace('\\','/').casefold().rstrip('/')

def retained_owner_ids(directory,rows):
    """Positive PID/creation/image/argv proof permits independent owned services."""
    data=directory/'data';path=data/'preview-installation.json'
    if not path.exists():return set()
    manifest=release.read_json(path,65536)
    if manifest.get('schema')!=1 or not isinstance(manifest.get('binaries'),dict) or not re.fullmatch(r'[a-f0-9-]{36}',str(manifest.get('installation_id',''))):
        raise ProductError('preview_installation_metadata_invalid')
    from web_host_supervisor_owner import command_argv
    by_pid={r['ProcessId']:r for r in rows};allowed=set();job_parents=set()
    launch=data/'preview-launch.json'
    if launch.exists() and release.read_json(launch).get('completion_unknown') is True:
        raise ProductError('preview_launch_completion_unknown')
    record=data/'preview-owners.json'
    if record.exists():
        saved=release.read_json(record,65536)
        if saved.get('installation_id')!=manifest['installation_id'] or not isinstance(saved.get('owners'),dict):raise ProductError('preview_owner_metadata_invalid')
        config_path=data/'web-host/backend-launch.json';release.no_link_directory(config_path.parent)
        config=release.read_json(config_path) if config_path.exists() else {}
        for role,owner in saved['owners'].items():
            row=by_pid.get(owner.get('pid'))
            if row is None:continue
            key=role if role in ('server','runner') else 'tunnel' if role in ('A','B') else None
            if not key:raise ProductError('preview_owner_metadata_invalid')
            expected=manifest['binaries'].get(key)
            if (not expected or row.get('CreationFiletime')!=owner.get('creation_filetime') or
                normalized(row.get('ExecutablePath',''))!=normalized(owner.get('executable','')) or
                normalized(row.get('ExecutablePath',''))!=normalized(expected)):
                raise ProductError('preview_retained_owner_unverified')
            args=command_argv(row.get('CommandLine'))
            wanted=[expected]
            if role=='runner':wanted+=['--config',config.get('runner_config','')]
            elif role in ('A','B'):wanted+=['run','--profile-file',str(data/'preview-private'/('account-'+role+'.yaml'))]
            if len(args)!=len(wanted) or any(normalized(a)!=normalized(b) for a,b in zip(args,wanted)):
                raise ProductError('preview_retained_owner_unverified')
            allowed.add(row['ProcessId'])
            if role=='runner':job_parents.add(row['ProcessId'])
    watch=data/'preview-watch/owner.json';release.no_link_directory(watch.parent)
    if watch.exists():
        owner=release.read_json(watch,8192);row=by_pid.get(owner.get('pid'))
        if row is not None:
            if row.get('CreationFiletime')!=owner.get('creation_filetime') or normalized(row.get('ExecutablePath',''))!=normalized(owner.get('executable','')):
                raise ProductError('preview_retained_watch_unverified')
            args=command_argv(row.get('CommandLine'))
            if len(args)!=5 or args[1]!='-B' or args[3]!='--root':raise ProductError('preview_retained_watch_unverified')
            code=Path(args[4]);release.no_link_directory(code)
            if code.parent!=directory/'versions' or not release.BUILD.fullmatch(code.name) or normalized(args[2])!=normalized(code/'scripts/preview_connection_watch.py') or not release.linked(code/'.local') or (code/'.local').resolve()!=data.resolve():
                raise ProductError('preview_retained_watch_unverified')
            digest=__import__('hashlib').sha256()
            for name in ('preview_installation.py','preview_connections.py','preview_connection_watch.py'):
                digest.update(release.plain(code/'scripts'/name,code).read_bytes())
            if digest.hexdigest()!=owner.get('source_sha256'):raise ProductError('preview_retained_watch_unverified')
            allowed.add(row['ProcessId'])
    # A Job may use the bundled Python/PowerShell without becoming a GUI
    # owner. Admit only a complete, creation-ordered chain from a verified
    # Runner; incomplete ancestry remains an explicit ownership refusal.
    changed=True
    while changed:
        changed=False
        for row in rows:
            if row['ProcessId'] in allowed or row.get('ParentProcessId') not in job_parents:continue
            parent=by_pid[row['ParentProcessId']]
            if (not row.get('ExecutablePath') or not row.get('CommandLine') or
                not str(row.get('CreationFiletime','')).isdigit() or not str(parent.get('CreationFiletime','')).isdigit() or
                int(row['CreationFiletime'])<int(parent['CreationFiletime'])):continue
            if Path(row['ExecutablePath']).name.casefold() not in {'python.exe','pythonw.exe','pwsh.exe','powershell.exe','node.exe','bun.exe'}:continue
            command=row['CommandLine'].replace('\\','/').casefold()
            if any(name in command for name in ('scripts/web_host_launcher.py','scripts/serve_harness.py','scripts/harness_managed_stdio.py')):continue
            allowed.add(row['ProcessId']);job_parents.add(row['ProcessId']);changed=True
    return allowed

def workspace_idle(directory,rows=None):
    directory=Path(directory).resolve();rows=release.process_rows(directory,include_native=True) if rows is None else rows
    rows=[row for row in rows if not (row.get('ProcessId')==os.getpid() and normalized(row.get('ExecutablePath',''))==normalized(sys.executable))]
    allowed=retained_owner_ids(directory,rows)
    release.require_idle(directory,[row for row in rows if row['ProcessId'] not in allowed])
    return {'retained_owner_pids':sorted(allowed)}

def root_link(directory):
    link=directory/'.local';data=directory/'data'
    if link.exists() or release.linked(link):
        if not release.linked(link) or link.resolve()!=data.resolve():raise ProductError('preview_root_data_link_unknown')
    else:release.junction(link,data)

def write_launcher(directory):
    for name,content in [('CLW.cmd',PREVIEW_LAUNCHER),('CLW.vbs',PREVIEW_GUI_LAUNCHER),('MAINTENANCE.cmd',MAINTENANCE_LAUNCHER)]:
        target=directory/name
        if target.exists() or release.linked(target):
            if release.linked(target) or target.read_bytes()!=content:raise ProductError('preview_launcher_unknown')
        else:
            with target.open('xb') as stream:stream.write(content)

def adopt_inno_shell(directory,manifest):
    """Inno owns only its uninstaller subdirectory before the payload is installed."""
    if (directory/'installation.json').exists():return
    children=list(directory.iterdir()) if directory.exists() else []
    if any(p.name!='installer' for p in children):raise ProductError('candidate_existing_root_not_adopted')
    shell=directory/'installer';release.no_link_directory(shell)
    if shell.exists():
        files=list(shell.iterdir())
        if any(release.linked(p) or (p.name!='bootstrap' and (not p.is_file() or not re.fullmatch(r'unins\d{3}\.(exe|dat|msg)',p.name,re.I))) for p in files):
            raise ProductError('preview_installer_shell_unknown')
        bootstrap=shell/'bootstrap'
        if bootstrap.exists():
            expected={n:r for n,r in manifest['files'].items() if n.startswith('runtime/python/') or n in release.BOOTSTRAP_SCRIPTS}
            actual={}
            for folder,dirs,names in os.walk(bootstrap,followlinks=False):
                if any(release.linked(Path(folder)/d) for d in dirs):raise ProductError('preview_installer_shell_unknown')
                for name in names:
                    path=Path(folder)/name
                    if release.linked(path):raise ProductError('preview_installer_shell_unknown')
                    actual[path.relative_to(bootstrap).as_posix()]=release.file_hash(path)
            if actual!=expected:raise ProductError('preview_installer_bootstrap_changed')
    directory.mkdir(parents=True,exist_ok=True)
    atomic_json(directory/'installation.json',{'schema':1,'product':release.PRODUCT,
        'installation_id':uuid.uuid4().hex,'root':str(directory.resolve()),'data_epoch':manifest['data_epoch']})

def installed_configuration(code):
    module=code/'scripts/preview_installation.py'
    if not module.is_file():raise ProductError('preview_bootstrap_missing')
    # Import this installed build's implementation, never a neighboring checkout.
    import importlib.util
    scripts=str(code/'scripts')
    if scripts not in sys.path:sys.path.insert(0,scripts)
    spec=importlib.util.spec_from_file_location('preview_installation',module)
    bootstrap=importlib.util.module_from_spec(spec);spec.loader.exec_module(bootstrap)
    return bootstrap

def initialize_preview(directory,code,*,implementation_code=None,maintenance=False):
    """Configuration only. The owned backend is started by an explicit app launch."""
    bootstrap=installed_configuration(implementation_code or code)
    binaries={key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
    try:
        if maintenance:bootstrap.initialize(code,binaries,maintenance=True)
        else:bootstrap.initialize(code,binaries)
    except ValueError as error:
        # The installed bootstrap and watch can load distinct module instances.
        # Preserve only their fixed PreviewError codes across that boundary.
        if type(error).__name__!='PreviewError' or not re.fullmatch(r'preview_[a-z0-9_]+',str(error)):raise
        raise ProductError(str(error)) from None

def install_preview(archive,directory,expected_sha256,*,inno_layout=False,initialize=True,owner_probe=workspace_idle,on_phase=None):
    phase=on_phase or (lambda _:None)
    directory=release.no_link_directory(directory).resolve()
    phase('verify_archive')
    manifest=release.verify_archive(archive,expected_sha256)
    if manifest['runtime_contract'].get('private_python')!=release.PRIVATE_RUNTIME['private_python']:
        raise ProductError('preview_private_runtime_required')
    phase('guard')
    if directory.exists() and (directory/'installation.json').exists():
        release.installation_identity(directory);owner_probe(directory)
        original=release.selected(directory)
    else:
        original=None
        if inno_layout:adopt_inno_shell(directory,manifest)
    release.install(archive,directory,expected_sha256,on_phase=phase)
    phase('select')
    def initialize_before_selection(code):
        phase('init');initialize_preview(directory,code,maintenance=True);phase('select')
    release.select(directory,manifest['build_id'],original['build_id'] if original else None,owner_probe=owner_probe,
                   before_publish=initialize_before_selection if initialize else None)
    phase('root_junction');root_link(directory)
    phase('launcher');write_launcher(directory)
    code=directory/'versions'/manifest['build_id']
    phase('prune')
    retained=prune_versions(directory,owner_probe=owner_probe)
    return {'state':'preview_installed','build_id':manifest['build_id'],'install_root':str(directory),
        'data_root':str(directory/'data'),'application_started':False,'model_sends':0,'retention':retained}

def rollback(directory,*,owner_probe=workspace_idle):
    directory=release.no_link_directory(directory).resolve();current=release.selected(directory)
    if not current or not current['previous']:raise ProductError('preview_no_rollback_build')
    # Run the current audited bootstrap when targeting an older version whose
    # initializer predates the maintenance argument and rebind behavior.
    implementation=directory/'versions'/current['build_id']
    before=(lambda code:initialize_preview(directory,code,implementation_code=implementation,maintenance=True)) if (directory/'data/preview-installation.json').exists() else None
    return release.select(directory,current['previous'],current['build_id'],owner_probe=owner_probe,before_publish=before)

def remove_verified_version(code,data):
    release.verify_version(code,data)
    link=code/'.local'
    if os.name=='nt':link.rmdir()
    else:link.unlink()
    # verify_version proves all remaining members are this release's exact files.
    shutil.rmtree(code)

def prune_versions(directory,*,owner_probe=workspace_idle):
    try:return _prune_versions(directory,owner_probe=owner_probe)
    except ProductError as error:return {'removed':[],'deferred':True,'reason':str(error)}

def _prune_versions(directory,*,owner_probe=workspace_idle):
    directory=release.no_link_directory(directory).resolve()
    release.installation_identity(directory)
    removed=[];retained=[]
    with FileLease(directory/'.release.lock'),FileLease(directory/'data/.run.lock'):
        current=release.selected(directory)
        if not current:raise ProductError('candidate_no_active_build')
        keep={current['build_id'],current['previous']}
        metadata=directory/'data/preview-installation.json'
        if metadata.exists():
            configuration=release.read_json(metadata,65536)
            for path in configuration.get('binaries',{}).values():
                try:relative=Path(path).resolve().relative_to((directory/'versions').resolve())
                except ValueError:continue
                if relative.parts and release.BUILD.fullmatch(relative.parts[0]):keep.add(relative.parts[0])
        try:owner_probe(directory)
        except ProductError as error:
            return {'removed':[],'deferred':True,'reason':str(error)}
        rows=release.process_rows(directory,include_native=True)
        for code in sorted((directory/'versions').iterdir()):
            prefix=normalized(code)+'/'
            if not release.BUILD.fullmatch(code.name) or code.name in keep or any(release.version_process(row,prefix) for row in rows):
                retained.append(code.name);continue
            try:remove_verified_version(code,directory/'data');removed.append(code.name)
            except (ProductError,OSError):retained.append(code.name)
    return {'removed':removed,'retained':retained,'deferred':False}

def uninstall_preview(directory,*,owner_probe=workspace_idle):
    """Remove verified application versions, preserve data and all independent Jobs.

    An active or unobservable owner defers physical removal. No process is stopped.
    Inno can still remove its shortcut and registration while the owner finishes.
    """
    directory=release.no_link_directory(directory).resolve();release.installation_identity(directory)
    try:
        with FileLease(directory/'.release.lock'),FileLease(directory/'data/.run.lock'):
            owner_probe(directory)
            current=release.selected(directory)
            if current and (directory/'data/preview-installation.json').exists():
                code=directory/'versions'/current['build_id'];configuration=installed_configuration(code)
                configuration.disable_auto_connect(code)
            all_versions=[code for code in sorted((directory/'versions').iterdir()) if release.BUILD.fullmatch(code.name)]
            rows=release.process_rows(directory,include_native=True)
            retained=[code for code in all_versions if any(release.version_process(row,normalized(code)+'/') for row in rows)]
            versions=[code for code in all_versions if code not in retained]
            for code in versions:release.verify_version(code,directory/'data')
            release.verify_manager(directory)
            launcher=directory/'CLW.cmd'
            if launcher.exists() and (release.linked(launcher) or launcher.read_bytes()!=PREVIEW_LAUNCHER):raise ProductError('preview_launcher_unknown')
            gui_launcher=directory/'CLW.vbs'
            if gui_launcher.exists() and (release.linked(gui_launcher) or gui_launcher.read_bytes()!=PREVIEW_GUI_LAUNCHER):raise ProductError('preview_launcher_unknown')
            maintenance=directory/'MAINTENANCE.cmd'
            if maintenance.exists() and (release.linked(maintenance) or maintenance.read_bytes()!=MAINTENANCE_LAUNCHER):raise ProductError('preview_launcher_unknown')
            atomic_json(directory/'uninstall-retained.json',{'schema':1,'state':'unregistered_data_retained',
                'data_root':str(directory/'data'),'at':release.utc(),'processes_stopped':False})
            # Inno invokes the separate installer/bootstrap interpreter. A
            # direct invocation from a version is retained until it exits.
            executing=Path(sys.executable).resolve()
            if executing.is_relative_to((directory/'versions').resolve()):
                return {'state':'preview_unregistered_cleanup_deferred','reason':'preview_uninstaller_runtime_in_use',
                    'data_retained':True,'jobs_retained':True,'versions_retained':True,'processes_stopped':False}
            for code in versions:remove_verified_version(code,directory/'data')
            identity=release.read_json(directory/'manager/identity.json')
            for relative in identity['files']:(directory/relative).unlink()
            (directory/'manager/identity.json').unlink();(directory/'manager').rmdir()
            if launcher.exists():launcher.unlink()
            if gui_launcher.exists():gui_launcher.unlink()
            if maintenance.exists():maintenance.unlink()
            if (directory/'active.json').exists():(directory/'active.json').unlink()
            return {'state':'preview_unregistered','data_retained':True,'jobs_retained':True,'versions_retained':bool(retained),
                'retained_builds':[code.name for code in retained],'reason':'owned_connections_or_jobs_running' if retained else None,'processes_stopped':False}
    except ProductError as error:
        return {'state':'preview_unregistered_cleanup_deferred','reason':str(error),'data_retained':True,
            'jobs_retained':True,'versions_retained':True,'processes_stopped':False}

def guard(directory):
    directory=release.no_link_directory(directory).resolve();release.installation_identity(directory)
    with FileLease(directory/'.release.lock'),FileLease(directory/'data/.run.lock'):
        workspace_idle(directory)
        if release.selected(directory):release.inspect(directory)
    return {'state':'preview_installation_idle','processes_stopped':False}

def maintenance_menu(directory,*,read_input=input,write=print):
    directory=release.no_link_directory(directory).resolve()
    while True:
        report=release.inspect(directory);current=release.selected(directory)
        write('\nCLW Preview maintenance\nVersion: '+report['version']+'\nCurrent: '+report['build_id']+
              '\nRollback: '+str(current['previous'] or 'not available')+'\n\n1. Verify this installation\n2. Roll back to the previous version\n3. Exit')
        try:choice=read_input('Choose 1, 2, or 3: ').strip()
        except (EOFError,KeyboardInterrupt):return {'state':'preview_maintenance_closed'}
        if choice=='3':return {'state':'preview_maintenance_closed'}
        try:
            if choice=='1':write(json.dumps(release.inspect(directory),ensure_ascii=False,indent=2))
            elif choice=='2':write(json.dumps(rollback(directory),ensure_ascii=False,indent=2))
        except ProductError as error:write('Action deferred: '+str(error)+'. Close the CLW window normally and retry. Existing Jobs were retained.')

def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    install=commands.add_parser('install');install.add_argument('--archive',type=Path,required=True)
    install.add_argument('--sha256',required=True);install.add_argument('--inno-layout',action='store_true')
    for command in [install,*[commands.add_parser(n) for n in ('inspect','rollback','prune','uninstall','guard','menu')]]:
        command.add_argument('--install-root',type=Path,required=True)
        command.add_argument('--result-file',type=Path)
    args=parser.parse_args()
    current_phase=args.command
    def phase(value):
        nonlocal current_phase
        current_phase=value
    def emit(value):
        if args.result_file is not None:
            release.no_link_directory(args.result_file.parent)
            atomic_json(args.result_file,{'schema':1,**value})
        print(json.dumps(value,ensure_ascii=False))
    try:
        if args.command=='install':result=install_preview(args.archive,args.install_root,args.sha256,inno_layout=args.inno_layout,on_phase=phase)
        elif args.command=='rollback':result=rollback(args.install_root)
        elif args.command=='prune':result=prune_versions(args.install_root)
        elif args.command=='uninstall':result=uninstall_preview(args.install_root)
        elif args.command=='guard':result=guard(args.install_root)
        elif args.command=='menu':result=maintenance_menu(args.install_root)
        else:result=release.inspect(args.install_root)
        emit({**result,'phase':'complete'})
        return 2 if result.get('state')=='preview_unregistered_cleanup_deferred' else 0
    except (ProductError,OSError,subprocess.SubprocessError) as error:
        emit({'state':'rejected','code':str(error) if isinstance(error,ProductError) else 'preview_io_unavailable',
            'phase':current_phase,'errno':getattr(error,'errno',None),'winerror':getattr(error,'winerror',None),
            'returncode':getattr(error,'returncode',None),
            'processes_stopped':False,'model_sends':0});return 2
    except (ValueError,RuntimeError,KeyError,TypeError):
        emit({'state':'rejected','code':'preview_configuration_or_ownership_unavailable',
            'phase':current_phase,
            'processes_stopped':False,'model_sends':0});return 2
if __name__=='__main__':raise SystemExit(main())
