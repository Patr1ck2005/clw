"""Read original native Codex Web packages, optionally waiting locally for one to need review."""
from pathlib import Path
import argparse,json,os,ctypes,sys,re,math,time
from datetime import datetime,timedelta,timezone
from native_work_admission import status as admission_status,settle as settle_admission,recover as recover_admission,claim_owner_live,AdmissionError

def instant(value):
    try:return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)
    except (ValueError,AttributeError):return None

def native_evidence(thread,row,sessions=None):
    """CLI --json omits some items (notably view_image). Read the exact native
    session as additional evidence, bounded to this package's execution window.
    Never return arguments, output text, prompts or other tasks' data.
    """
    unavailable={'state':'unavailable','executionAbsenceProven':False}
    if not isinstance(thread,str) or not re.fullmatch(r'[0-9a-fA-F-]{36}',thread):return unavailable
    start=instant(row.get('startedAt'));end=instant(row.get('endedAt')) or datetime.now(timezone.utc)
    if not start:return unavailable
    try:created=datetime.fromtimestamp(int(thread.replace('-','')[:12],16)/1000,timezone.utc)
    except (ValueError,OverflowError,OSError):return unavailable
    home=Path(sessions) if sessions is not None else Path(os.environ.get('CODEX_HOME',Path.home()/'.codex'))/'sessions'
    candidates=[]
    # UUID v7 identifies the creation day; +/-1 accounts for local day naming.
    for day in (created+timedelta(days=d) for d in (-1,0,1)):
        candidates.extend((home/day.strftime('%Y/%m/%d')).glob('*'+thread+'.jsonl'))
    if len(candidates)!=1:return unavailable
    source=candidates[0];owned=False;calls={};returned=set()
    try:
        with source.open(encoding='utf-8-sig',errors='replace') as file:
            for line in file:
                try:item=json.loads(line)
                except RecursionError:return unavailable
                except ValueError:continue
                if not isinstance(item,dict):return unavailable
                payload=item.get('payload',{})
                if not isinstance(payload,dict):return unavailable
                if item.get('type')=='session_meta':owned=payload.get('id')==thread
                if not owned or item.get('type')!='response_item':continue
                at=instant(item.get('timestamp'))
                if not at or not start<=at<=end:continue
                kind=payload.get('type');call=payload.get('call_id');name=payload.get('name')
                if kind in ('function_call','custom_tool_call') and isinstance(call,str) and isinstance(name,str):calls[call]=name
                if kind in ('function_call_output','custom_tool_call_output') and isinstance(call,str):returned.add(call)
    except OSError:return unavailable
    if not owned:return unavailable
    counts={}
    for call,name in calls.items():
        value=counts.setdefault(name,{'invocations':0,'returned':0});value['invocations']+=1;value['returned']+=int(call in returned)
    return {'state':'observed','source':str(source),'tools':counts,'executionAbsenceProven':False,
            'note':'Native records supplement CLI events. A returned tool result is not proof of success; review its original receipt and project artifacts.'}

def alive(pid):
    if not isinstance(pid,int) or pid<=0:return False
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype=ctypes.c_void_p
        handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle:return False
        try:
            code=ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(code))) and code.value==259
        finally:kernel.CloseHandle(ctypes.c_void_p(handle))
    try:os.kill(pid,0);return True
    except OSError:return False

def reported_blockers(directory):
    """Surface exact error mentions without promoting a model's explanation
    to a verified platform decision or automatically retrying denied work.
    The final file stays authoritative and is never copied into diagnostics.
    """
    file=directory/'final.md'
    try:
        if file.stat().st_size>4*1024*1024:return []
        final=file.read_text(encoding='utf-8-sig',errors='replace')
    except OSError:return []
    # Public Markdown may escape tool-name underscores. Normalize only those
    # presentation escapes; keep the original report as the evidence source.
    searchable=final.replace('\\_', '_')
    rules=json.loads((Path(__file__).resolve().parents[1]/'apps/codex-web-bridge/reported-blockers.json').read_text(encoding='utf8'))
    return [{'code':code,'source':'assistant_final','evidence':'reported_not_independently_verified',
             'sourceFile':str(file),'automaticRetry':False}
            for code,pattern in ((r['code'],r['pattern']) for r in rules) if re.search(pattern,searchable,re.I)]

def inspect(directory,*,sessions=None,admission_database=None):
    directory=Path(directory).resolve()
    try:row=json.loads((directory/'execution.json').read_text(encoding='utf-8-sig'))
    except RecursionError:raise ValueError('native_execution_receipt_invalid') from None
    if not isinstance(row,dict):raise ValueError('native_execution_receipt_invalid')
    row['resultDirectory']=str(directory);row['ownerAlive']=alive(row.get('ownerPid'))
    if row.get('admissionId'):
        database=Path(admission_database) if admission_database is not None else Path(__file__).resolve().parents[1]/'.local/harness/harness.sqlite3'
        try:
            original=admission_status(database,directory)
            if original.get('claim_id')==row['admissionId'] and original.get('ownerPid')==row.get('ownerPid') and 'created' in original:
                row['ownerAlive']=claim_owner_live({'owner_pid':original['ownerPid'],'created':original['created']})
        except (AdmissionError,OSError,ValueError):pass
    if row['state'] in ('starting','running') and row['ownerAlive'] is False:row['state']='owner_gone_reconcile_original'
    events=directory/'events.jsonl';counts={};thread=None;native_failure=None;terminal=None
    if events.exists():
        with events.open('rb') as f:encoding='utf-16' if f.read(2) in (b'\xff\xfe',b'\xfe\xff') else 'utf-8-sig'
        with events.open(encoding=encoding,errors='replace') as f:
            for line in f:
                try:event=json.loads(line)
                except RecursionError:
                    row['eventReadIssue']='malformed_event_record';continue
                except ValueError:continue # last frame may still be in flight
                if not isinstance(event,dict):
                    row['eventReadIssue']='malformed_event_record';continue
                if event.get('type')=='thread.started':
                    if isinstance(event.get('thread_id'),str):thread=event['thread_id']
                    else:row['eventReadIssue']='malformed_event_record'
                if event.get('type')=='item.completed':
                    item=event.get('item',{})
                    if not isinstance(item,dict):row['eventReadIssue']='malformed_event_record';continue
                    kind=item.get('type','unknown')
                    if not isinstance(kind,str):row['eventReadIssue']='malformed_event_record';continue
                    counts[kind]=counts.get(kind,0)+1
                if event.get('type')=='turn.completed':terminal='completed'
                if event.get('type')=='turn.failed':
                    terminal='failed';error=event.get('error',{})
                    native_failure=error.get('message','Native turn failed') if isinstance(error,dict) else 'Native turn failed'
    # A normal model answer may report a platform refusal or unfinished work.
    # The transport cannot certify the user's acceptance conditions from exit 0.
    if row['state']=='completed':row['state']='turn_completed'
    row.update(threadId=thread,completedItems=counts,finalFile=str(directory/'final.md'),nativeFailure=native_failure,
               nativeTurnState=terminal,taskAcceptance='unverified',requiresResultReview=True)
    row['nativeSessionEvidence']=native_evidence(thread,row,sessions)
    from native_work_completion import completed_tools_evidence
    row['nativeWorkCompletionEvidence']=completed_tools_evidence(directory,row,sessions=sessions)
    row['reportedBlockers']=reported_blockers(directory)
    # A completed transport can carry an unsuccessful work result. Preserve the
    # native terminal state and separately request review of reported blockers.
    row['reviewStatus']='reported_blocker_requires_review' if row['reportedBlockers'] else 'result_requires_review'
    if row.get('admissionId'):
        database=Path(admission_database) if admission_database is not None else Path(__file__).resolve().parents[1]/'.local/harness/harness.sqlite3'
        try:row['writeDomainAdmission']=admission_status(database,directory)
        except (AdmissionError,OSError,ValueError):row['writeDomainAdmission']={'state':'unavailable','cooperativeOnly':True}
    if row.get('writeDomainAdmission', {}).get('recovery') == 'interrupted_connection_failure':
        row['state'] = 'interrupted'
        row['reviewStatus'] = 'interrupted_result_unverified'
        row['automaticReplay'] = False
    if row.get('writeDomainAdmission', {}).get('recovery') == 'cancelled_before_native_start':
        row['state'] = 'not_sent'
        row['reviewStatus'] = 'connection_changed_before_start'
        row['automaticReplay'] = False
    if row.get('writeDomainAdmission', {}).get('recovery') == 'pre_send_cancelled':
        row['state'] = 'not_sent'
        row['reviewStatus'] = 'original_launcher_ended_before_start'
        row['automaticReplay'] = False
    if row.get('writeDomainAdmission', {}).get('recovery') in ('cancelled_stopped_execution','cancelled_native_terminal'):
        row['state'] = 'interrupted'
        row['reviewStatus'] = 'cancelled_result_unverified'
        row['automaticReplay'] = False
    return row

MAX_WAIT_SECONDS=86400
PENDING_STATES={'queued_local','starting','running'}
TERMINAL_STATES={'completed','turn_completed','needs_attention','failed','interrupted','not_sent'}

def wait_seconds(value):
    try:seconds=float(value)
    except (ValueError,TypeError):raise argparse.ArgumentTypeError('wait seconds must be a finite number from 0 to 86400') from None
    if not math.isfinite(seconds) or not 0<=seconds<=MAX_WAIT_SECONDS:
        raise argparse.ArgumentTypeError('wait seconds must be a finite number from 0 to 86400')
    return seconds

def execution_observation(directory):
    """Poll only the small launcher receipt; never scan events, Sessions or Jobs."""
    path=Path(directory)/'execution.json'
    observation={'resultDirectory':str(directory),'status':'needs_attention','ownerAlive':None}
    try:
        before=path.stat()
        if not 0<before.st_size<=65536:raise ValueError('execution_receipt_size_invalid')
        with path.open('rb') as stream:raw=stream.read(65537)
        after=path.stat()
        if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or len(raw)!=before.st_size:
            raise ValueError('execution_receipt_changed')
        row=json.loads(raw.decode('utf-8-sig'))
        if not isinstance(row,dict) or not isinstance(row.get('state'),str) or not row['state']:
            raise ValueError('execution_receipt_invalid')
    except (OSError,ValueError,UnicodeError,RecursionError):
        return {**observation,'reason':'execution_metadata_unavailable'}
    state=row['state'];pid=row.get('ownerPid')
    owner=alive(pid) if type(pid) is int and pid>0 else None
    observation.update(executionState=state,ownerAlive=owner)
    if state not in PENDING_STATES|TERMINAL_STATES:
        return {**observation,'reason':'unknown_execution_state'}
    if state in PENDING_STATES:
        if owner is True:return {**observation,'status':'pending','reason':'launcher_pending'}
        return {**observation,'reason':'owner_gone_reconcile_original' if owner is False else 'owner_identity_unavailable'}
    # The launcher writes its terminal receipt before settling the write claim.
    # Prefer its exit, but a bounded wait may return while it is still finishing.
    if owner is True:return {**observation,'status':'pending','reason':'launcher_finishing'}
    if owner is None:return {**observation,'reason':'owner_identity_unavailable'}
    return {**observation,'status':'ready','reason':'terminal_requires_review'}

def wait_for_packages(directories,seconds,*,poll_interval=1):
    """Wait for ANY original package, with no model calls, writes or cancellation.

    Missing or partially written receipts get at most three consecutive probes.
    Unknown metadata returns to the caller for reconciliation, never replay.
    The deadline limits only this read-only wait, not the original work.
    """
    seconds=wait_seconds(seconds)
    if not directories:raise ValueError('at_least_one_result_directory_required')
    if not math.isfinite(poll_interval) or poll_interval<=0:raise ValueError('poll_interval_invalid')
    started=time.monotonic();deadline=started+seconds;failures={str(path):0 for path in directories}
    while True:
        observations=[execution_observation(path) for path in directories]
        retrying=False
        for observation in observations:
            key=observation['resultDirectory']
            if observation['reason']=='execution_metadata_unavailable':
                failures[key]+=1
                if failures[key]<3 and seconds>0:
                    observation['status']='pending';retrying=True
            else:failures[key]=0
        ready=[value['resultDirectory'] for value in observations if value['status']!='pending']
        now=time.monotonic()
        reason='snapshot' if seconds==0 else 'any_ready' if ready else 'timeout' if now>=deadline else None
        if reason:
            return {'reason':reason,'waitSeconds':seconds,'elapsedSeconds':round(now-started,3),
                    'readyResultDirectories':ready,'observations':observations,
                    'readOnly':True,'modelSends':0,'claimReleaseVerified':False}
        time.sleep(min(0.25 if retrying else poll_interval,deadline-now))

def inspect_after_wait(directory):
    """Keep a receipt read race visible without treating unknown work as success."""
    try:return inspect(directory)
    except (OSError,ValueError,KeyError,TypeError,RecursionError):
        return {'resultDirectory':str(directory),'state':'unknown_reconcile_original',
                'reviewStatus':'execution_metadata_unavailable','taskAcceptance':'unverified',
                'requiresResultReview':True,'automaticReplay':False}

def main(argv=None):
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('result_directory',nargs='+')
    parser.add_argument('--wait-seconds',type=wait_seconds,default=0,
                        help='Wait locally up to N seconds (0..86400) for any original package; does not stop work or accept its result')
    actions=parser.add_mutually_exclusive_group()
    actions.add_argument('--settle-admission',action='store_true',help='Read original native tools and owned Workflow Jobs, then release the verified cooperative write claim')
    actions.add_argument('--recover-admission',action='store_true',help='Audit the original dead launcher and proven pre-send or terminal work; unrelated Jobs do not define completion')
    args=parser.parse_args(argv)
    if any(not value.strip() for value in args.result_directory):parser.error('result directories must not be empty')
    directories=[Path(value).resolve() for value in args.result_directory]
    if len({os.path.normcase(str(path)) for path in directories})!=len(directories):
        parser.error('duplicate result directories are not allowed')
    action_requested=args.settle_admission or args.recover_admission
    if action_requested and (len(directories)!=1 or args.wait_seconds>0):
        parser.error('admission actions require one directory without a positive wait; inspect waiting results first')
    if len(directories)>1 or args.wait_seconds>0:
        waited=wait_for_packages(directories,args.wait_seconds)
        packages=[inspect_after_wait(path) for path in directories]
        result={'packages':packages,'wait':waited} if len(packages)>1 else {**packages[0],'wait':waited}
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0
    # Preserve the original single-directory output and explicit action contract.
    original_directory=args.result_directory[0];directory=directories[0]
    if args.recover_admission and not (directory/'execution.json').is_file():
        database=Path(__file__).resolve().parents[1]/'.local/harness/harness.sqlite3'
        try:recovered=recover_admission(database,directory)
        except (AdmissionError,OSError,ValueError) as exc:recovered={'state':'held','reason':str(exc),'modelSends':0}
        print(json.dumps({'resultDirectory':str(directory),'admissionSettle':recovered,
                          'writeDomainAdmission':admission_status(database,directory),
                          'modelSends':0},ensure_ascii=False,indent=2))
        return 0
    result=inspect(original_directory)
    if (args.settle_admission or args.recover_admission) and result.get('admissionId'):
        database=Path(__file__).resolve().parents[1]/'.local/harness/harness.sqlite3'
        action=recover_admission if args.recover_admission else settle_admission
        try:result['admissionSettle']=action(database,directory)
        except (AdmissionError,OSError,ValueError) as exc:result['admissionSettle']={'state':'held','reason':str(exc),'modelSends':0}
        result['writeDomainAdmission']=admission_status(database,directory)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0

if __name__=='__main__':raise SystemExit(main())
