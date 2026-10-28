"""Normal user-started supervisor for the CLW dedicated browser.

No scheduled task, login start-up entry, provider configuration or OS policy is
installed. Explicit app exit ends supervision; crash bursts get bounded retries.
"""
from pathlib import Path
from datetime import datetime
import json,subprocess,time,shutil,sqlite3,os,uuid,sys
from product_runtime import atomic_json,FileLease,ProductError
from bounded_process import run_bounded
from web_host_supervisor_owner import existing_browser,focus_existing,native_identity

ROOT=Path(__file__).resolve().parents[1]
DELAYS=(1,4,15)
SHARED_ENTRY_DELAYS=(1,4)
STABLE_SECONDS=60
HEALTH_MAX_AGE_SECONDS=15
VERIFIED_VPN_STATE='VPN 已连接 · 直连已禁用'

class SharedEntryStartupError(RuntimeError):
    def __init__(self,stage,reason,retryable=False,completion_unknown=False):
        super().__init__(reason)
        self.stage=stage;self.reason=reason;self.retryable=retryable
        self.completion_unknown=completion_unknown

def shared_entry_error(error,stage):
    # Persist fixed codes only. Subprocess errors may contain credential-bearing
    # output or command arguments and must never be written to support files.
    if isinstance(error,SharedEntryStartupError):return error
    backend_codes={
        'backend_server_not_ready','backend_runner_exited',
        'backend_launch_manifest_missing','backend_manifest_version_invalid',
        'backend_origin_must_be_loopback','backend_process_identity_unknown',
        'backend_endpoint_has_unverified_owner',
        'backend_multiple_owners:server','backend_multiple_owners:runner',
        *('backend_installed_file_missing:'+field for field in
          ('server','runner','cli','env_file','runner_config')),
    }
    if stage=='backend' and isinstance(error,RuntimeError) and str(error) in backend_codes:
        reason=str(error)
        return SharedEntryStartupError(stage,reason,
            reason in {'backend_server_not_ready','backend_runner_exited'}
            and not getattr(error,'completion_unknown',False),
            completion_unknown=getattr(error,'completion_unknown',False))
    if isinstance(error,subprocess.TimeoutExpired):return SharedEntryStartupError(stage,'startup_timeout',completion_unknown=True)
    if isinstance(error,subprocess.CalledProcessError):
        detail=error.stderr if isinstance(error.stderr,str) else ''
        known={
            'different owner/state':'startup_owner_unverified',
            'owner changed':'startup_owner_unverified',
            'ambiguous A tunnel owners':'startup_owner_unverified',
            'loopback listener is ambiguous':'startup_owner_unverified',
            'union identity changed':'startup_owner_unverified',
            'desktop owner':'startup_owner_unverified',
            'Desktop reclaimed A':'startup_owner_unverified',
            'not idle and verified':'startup_jobs_not_idle',
            'active or unknown jobs':'startup_jobs_not_idle',
            'settings unavailable':'startup_config_unavailable',
            'authorization file reference is unavailable':'startup_config_unavailable',
            'Union did not become ready':'startup_union_not_ready',
            'Native process ownership is unavailable.':'startup_owner_unverified',
        }
        return SharedEntryStartupError(stage,next((code for text,code in known.items() if text in detail),'startup_script_failed'),
            completion_unknown=getattr(error,'completion_unknown',False))
    return SharedEntryStartupError(stage,'startup_metadata_invalid' if isinstance(error,(ValueError,KeyError,TypeError)) else 'startup_unavailable',
        completion_unknown=getattr(error,'completion_unknown',False))

def record_shared_entry(root,state,**fields):
    folder=root/'.local/web-host';folder.mkdir(parents=True,exist_ok=True)
    atomic_json(folder/'shared-entry-start.json',{'state':state,'automatic_fallback':False,
        'at':datetime.now().astimezone().isoformat(),**fields})

def explicit_exit(path,pid):
    try:
        value=json.loads(path.read_text(encoding='utf-8'))
        return value.get('pid')==pid and (value.get('explicit') is True or
            (value.get('explicit') is False and value.get('reason')=='maintenance'))
    except (OSError,ValueError,AttributeError):return False

def resolve_powershell7():
    explicit=os.environ.get('CLW_POWERSHELL')
    if explicit:
        candidate=Path(explicit)
        return str(candidate) if candidate.is_absolute() and candidate.is_file() else None
    bundled=ROOT/'runtime/powershell/pwsh.exe'
    if bundled.is_file():return str(bundled)
    shell=shutil.which('pwsh')
    if shell:return shell
    # Desktop shortcuts may have a smaller PATH than an interactive terminal.
    # Use only known installations, then the current user's bundled runtime.
    candidates=[Path(os.environ.get(variable) or default)/'PowerShell/7/pwsh.exe'
        for variable,default in (('ProgramW6432',r'C:\Program Files'),
            ('ProgramFiles',r'C:\Program Files'),('ProgramFiles(x86)',r'C:\Program Files (x86)'))]
    candidates.append(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')
    return next((str(path) for path in candidates if path.is_file()),None)

def prepare_shared_entry(root):
    # A self-contained preview owns its own descriptor and one lightweight
    # watch. Do not enter the legacy Desktop/A/B configuration path.
    if (root/'.local/preview-installation.json').is_file():
        from preview_installation import read
        saved=read(root)
        if saved['manifest'].get('auto_connect',True) and any(row.get('credentialConfigured') for row in saved.get('accounts',[])):
            run_bounded([sys.executable,'-X','utf8','-B',str(root/'scripts/preview_connection_watch.py'),'--root',str(root),'--start'],
                cwd=root,capture_stderr=True,capture_stdout=True,text=True,encoding='utf-8',timeout=15,check=True,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return
    settings=root/'.local/codex-web-bridge/settings.json'
    record_shared_entry(root,'preparing',stage='settings')
    if not settings.is_file():
        record_shared_entry(root,'not_configured',stage='settings');return
    try:
        selected=json.loads(settings.read_text(encoding='utf8'))
        if not isinstance(selected,dict):raise ValueError('settings_object_required')
    except (OSError,ValueError) as error:raise shared_entry_error(error,'settings') from None
    if not selected.get('enabled') or selected.get('transport')!='shared-mcp':
        record_shared_entry(root,'not_required',stage='settings');return
    from webcodex_backend import prepare
    record_shared_entry(root,'preparing',stage='backend')
    try:prepare(root)
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError) as error:
        raise shared_entry_error(error,'backend') from None
    shell=resolve_powershell7()
    if not shell:raise SharedEntryStartupError('shell','startup_shell_missing')
    def start_tunnel(account,timeout,*extra):
        record_shared_entry(root,'preparing',stage='tunnel_'+account)
        try:
            run_bounded([shell,'-NoProfile','-File',str(root/('scripts/start_local_mcp_'+account+'.ps1')),
              '-PythonExecutable',sys.executable,*extra],cwd=root,
              capture_stderr=True,timeout=timeout,check=True,
              text=True,encoding='utf8',errors='replace',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        except (OSError,subprocess.SubprocessError) as error:raise shared_entry_error(error,'tunnel_'+account) from None
    start_tunnel('b',60)
    if selected.get('webAccount','B')=='A':
        # Startup may reclaim the same configured A tunnel from Desktop after a
        # reboot. The helper verifies exact ownership and zero active Jobs first.
        start_tunnel('a',30,'-TakeOverDesktopTunnel')
    record_shared_entry(root,'ready')

def prepare_shared_entry_bounded(root,sleep=time.sleep,prepare=None):
    prepare=prepare or prepare_shared_entry
    for attempt in range(len(SHARED_ENTRY_DELAYS)+1):
        try:
            prepare(root)
            return
        except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError) as error:
            failure=shared_entry_error(error,'backend')
            retry=failure.retryable and attempt<len(SHARED_ENTRY_DELAYS)
            record_shared_entry(root,'retrying' if retry else 'needs_attention',
                stage=failure.stage,reason=failure.reason,attempts=attempt+1,
                completion_unknown=failure.reason=='startup_timeout'
                    or getattr(error,'completion_unknown',False))
            if not retry:return
            sleep(SHARED_ENTRY_DELAYS[attempt])

def verified_stable_run(path,pid,started_at,ended_at,elapsed):
    """Only a recent, same-process, connected VPN heartbeat renews the crash budget."""
    if elapsed<STABLE_SECONDS:return False
    try:
        health=json.loads(path.read_text(encoding='utf-8'))
        observed=datetime.fromisoformat(health['at'])
        if observed.tzinfo is None:return False
        observed_at=observed.timestamp()
        return (health.get('pid')==pid
                and health.get('connected') is True
                and (health.get('networkReady') is True or health.get('network')==VERIFIED_VPN_STATE)
                and started_at+STABLE_SECONDS<=observed_at<=ended_at
                and ended_at-observed_at<=HEALTH_MAX_AGE_SECONDS)
    except (OSError,ValueError,TypeError,KeyError,AttributeError):return False

def supervise(root=ROOT,spawn=subprocess.Popen,sleep=time.sleep,now=time.time,monotonic=time.monotonic):
    root=Path(root).resolve();exe=root/'apps/web-host/node_modules/electron/dist/electron.exe'
    if not exe.is_file():return 2
    folder=(root/'.local/web-host').resolve();folder.mkdir(parents=True,exist_ok=True)
    lease=FileLease(folder/'supervisor.lock')
    try:lease.__enter__()
    except ProductError as error:
        if str(error)!='data_in_use_no_process_stopped':raise
        original=existing_browser(root,folder,own_pid=os.getpid(),now=now)
        if original is None:raise ProductError('web_workspace_original_owner_unverified')
        return focus_existing(original,root,spawn)
    try:
        original=existing_browser(root,folder,own_pid=os.getpid(),now=now)
        if original:return focus_existing(original,root,spawn)
        return supervise_owned(root,folder,spawn,sleep,now,monotonic)
    finally:lease.__exit__(None,None,None)

def supervise_owned(root,folder,spawn,sleep,now,monotonic):
    # Only the kernel-lock owner may prepare services or publish lifecycle.
    exe=root/'apps/web-host/node_modules/electron/dist/electron.exe'
    state=folder/'supervisor.json';attempt=0;restarts=0
    expected=state.read_bytes() if state.exists() else None
    owner=native_identity(os.getpid());epoch=uuid.uuid4().hex
    def publish(value):
        nonlocal expected
        actual=state.read_bytes() if state.exists() else None
        if actual!=expected:raise ProductError('web_workspace_supervisor_state_changed')
        atomic_json(state,{**value,'owner_epoch':epoch,'supervisor_pid':owner['pid'],
                          'supervisor_creation_filetime':owner['creationFiletime'],'canonical_profile':str(folder)})
        expected=state.read_bytes()
    prepare_shared_entry_bounded(root,sleep)
    while True:
        if existing_browser(root,folder,own_pid=os.getpid(),now=now):
            raise ProductError('web_workspace_original_owner_unverified')
        args=[str(exe),str(root/'apps/web-host')]
        if restarts:args.append('--clw-recovered')
        child=spawn(args,cwd=str(root),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    close_fds=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:child_owner=native_identity(child.pid,'electron.exe')
        except ProductError:
            # The original Popen remains owned until it exits. Never drop its
            # lease, kill a GUI, or restart an unverified child.
            code=child.wait()
            if code==0:return code
            raise
        try:publish({'pid':child.pid,'restarts':restarts,'state':'running','child_creation_filetime':child_owner['creationFiletime']})
        except BaseException:
            child.wait();raise
        # Only goals explicitly enabled in the existing ledger are resumed.
        # The watcher waits for connected browser health and never starts Web.
        from harness_goal_watch import start_if_enabled
        try:start_if_enabled(root)
        except (OSError,ValueError,RuntimeError,sqlite3.Error):pass
        started_at=now();started_tick=monotonic()
        try:code=child.wait()
        except KeyboardInterrupt:
            (folder/'user-exit.json').write_text(json.dumps({'explicit':True,'pid':child.pid}),encoding='utf-8')
            child.terminate();child.wait()
            publish({'pid':child.pid,'restarts':restarts,'state':'stopped','child_creation_filetime':child_owner['creationFiletime']})
            return 0
        ended_at=now();elapsed=monotonic()-started_tick
        deliberate=explicit_exit(folder/'exit-record.json',child.pid)
        if code==0 or deliberate:
            publish({'pid':child.pid,'restarts':restarts,'state':'stopped','child_creation_filetime':child_owner['creationFiletime']});return code
        if verified_stable_run(folder/'health.json',child.pid,started_at,ended_at,elapsed):attempt=0
        if attempt>=len(DELAYS):
            publish({'pid':child.pid,'restarts':restarts,'state':'needs_attention','reason':'browser_crash_limit','child_creation_filetime':child_owner['creationFiletime']});return code
        sleep(DELAYS[attempt]);attempt+=1;restarts+=1

if __name__=='__main__':raise SystemExit(supervise())
