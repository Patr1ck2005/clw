"""Project-side managed page tools. Real Local-MCP Session identity is required."""
from pathlib import Path
from http.client import HTTPException
import argparse,json,sys,time,uuid
from harness_host_client import Client,ROOT
from harness_state import HarnessError,require,public
from harness_workspace_paths import normalize_scope_payload

def enter_first_task(client,enrollment,operation_id,timeout=1800,clock=time.monotonic,sleep=time.sleep,*,wait=True):
    """Try the original claim; CLI callers opt into waiting explicitly.

    The enrollment response is already persisted before this call. Preserve it
    when admission waits, so a caller never has to repeat enrollment to discover
    the original request. The function's wait default preserves existing API use.
    """
    if not enrollment.get('first_task'):return enrollment
    deadline=clock()+timeout
    key=str(uuid.uuid5(uuid.NAMESPACE_URL,'first-task:'+operation_id))
    def waiting(result,timed_out=False):
        return {**enrollment,'enrollment_receipt':enrollment,'first_task':result,
            'work_started':False,'state':'waiting_local_slot','wait_timed_out':timed_out,
            'next':'first-task','first_task_operation_id':key,
            'message':'Enrollment is saved; the original first task is waiting for a local slot. '
                f'In this same Web turn, recheck once with CLI first-task --operation-id {key}, '
                'retaining the original store, target and Session. '
                'Do not repeat enroll or start work before first_task_ready. '
                'This receipt does not resume a paused task or schedule another Web turn.'}
    while True:
        result=client.call('managed',op='first-task',operation_id=key,payload={})
        if result.get('state')!='waiting_local_slot':
            return {**enrollment,'first_task':result}
        if not wait:return waiting(result)
        remaining=deadline-clock()
        if remaining<=0:return waiting(result,timed_out=True)
        sleep(min(2,remaining))
        # Do not attempt a fresh claim after the caller's wait budget expired.
        if clock()>=deadline:return waiting(result,timed_out=True)

def first_task_reconcile_required(enrollment,operation_id,error):
    """Return the real enrollment even when the subsequent claim is unconfirmed."""
    key=str(uuid.uuid5(uuid.NAMESPACE_URL,'first-task:'+operation_id))
    detail={'type':type(error).__name__,'message':str(error)[:2048]}
    if isinstance(error,HarnessError):detail.update(code=error.code,status=error.status)
    if isinstance(error,OSError) and error.errno is not None:detail['errno']=error.errno
    first={'state':'first_task_reconcile_required',
        'request_id':enrollment['first_task'].get('request_id'),
        'work_started':False,'completion_unknown':True,'error':detail}
    return {**enrollment,'enrollment_receipt':enrollment,'first_task':first,
        'state':'first_task_reconcile_required','work_started':False,'completion_unknown':True,
        'next':'first-task','first_task_operation_id':key,'replayed':False,
        'message':'Enrollment is saved; the first-task check failed and execution is unconfirmed. '
            'Preserve the original error. Do not repeat enroll, change identities or start work. '
            f'If rechecking is permitted after resolving the error, reuse CLI first-task --operation-id {key} '
            'with the original store, target and Session. No automatic retry or resume was performed.'}

def read_payload(args,stream=None):
    if args.payload_stdin:
        raw=(stream or sys.stdin.buffer).read(256*1024+1)
        require(len(raw)<=256*1024,'managed_payload_bounds')
        raw=raw.decode('utf-8-sig')
    elif args.payload_file:
        path=Path(args.payload_file)
        require(path.is_file() and path.stat().st_size<=256*1024,'managed_payload_bounds')
        raw=path.read_text(encoding='utf-8-sig')
    else:raw=args.payload_json or '{}'
    payload=json.loads(raw);require(isinstance(payload,dict),'managed_payload_object')
    return payload

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('op',choices=['enroll','first-task','create','prepare-worker','context','pages','wait-pages','wait-ready','turn-end','handoff'])
    p.add_argument('--store-id',required=True);p.add_argument('--target',required=True);p.add_argument('--session-id',required=True)
    p.add_argument('--operation-id');p.add_argument('--timeout-seconds',type=int,default=1800)
    p.add_argument('--wait-first-task',action='store_true',
        help='Enroll only: explicitly wait for the original first task within --timeout-seconds; otherwise return its waiting receipt immediately.')
    p.add_argument('--attempt-id',help='Exact dispatched marker from this received Web prompt; context only.')
    source=p.add_mutually_exclusive_group()
    source.add_argument('--payload-json');source.add_argument('--payload-stdin',action='store_true',help='Bounded UTF-8 JSON from stdin; no result file write is needed.')
    source.add_argument('--payload-file',help='Existing authorized UTF-8 JSON file; no file is created.')
    a=p.parse_args();require(1<=a.timeout_seconds<=21600,'managed_wait_timeout');payload=read_payload(a)
    require(not a.wait_first_task or a.op=='enroll','managed_enroll_wait_only')
    if a.op=='create':payload=normalize_scope_payload(payload)
    if a.attempt_id:
        require(a.op=='context' and 'attempt_id' not in payload,'managed_attempt_context_only');payload['attempt_id']=a.attempt_id
    if a.op in ('create','prepare-worker','enroll','first-task','turn-end','handoff','wait-ready'):require(bool(a.operation_id),'managed_fixed_operation_id_required')
    key=a.operation_id or str(uuid.uuid4())
    if a.op=='create':payload.setdefault('page_id','web-'+str(uuid.uuid5(uuid.NAMESPACE_URL,a.target+':'+key)))
    c=Client('http://127.0.0.1:18944',ROOT/'.local/harness',a.store_id,a.target,a.session_id)
    if a.op=='wait-pages':
        targets=payload.get('targets');require(isinstance(targets,list) and targets,'managed_targets_required')
        require(1<=a.timeout_seconds<=21600,'managed_wait_timeout')
        deadline=time.monotonic()+a.timeout_seconds
        while True:
            found={};after=0
            while True:
                result=c.call('managed',op='pages',operation_id=key,payload={'after':after})
                found.update({x['target_id']:x for x in result['pages']})
                if not result['has_more']:break
                after=result['next_after']
            if all(t in found and found[t]['phase']=='bound' and not found[t]['paused'] and not found[t].get('work_model_pending') for t in targets):
                result={'state':'pages_ready','all_requested_ready':True,'count':len(targets),'model_called':False};break
            if time.monotonic()>=deadline:
                result={**result,'state':'wait_timeout','model_called':False};break
            time.sleep(2)
    else:
        result=c.call('managed',op=a.op,operation_id=key,payload=payload)
        if a.op=='enroll':
            enrollment=result
            try:result=enter_first_task(c,enrollment,key,a.timeout_seconds,
                clock=time.monotonic,sleep=time.sleep,wait=a.wait_first_task)
            except (HarnessError,OSError,ValueError,HTTPException) as error:
                result=first_task_reconcile_required(enrollment,key,error)
    print(json.dumps(public(result),ensure_ascii=False),flush=True)

if __name__=='__main__':
    try:main()
    except (HarnessError,ValueError,OSError,HTTPException) as e:
        print(json.dumps({'success':False,'code':getattr(e,'code','managed_client_failed'),'replayed':False}),flush=True);raise SystemExit(2)
