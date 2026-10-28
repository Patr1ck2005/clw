"""Bounded real-time CLW observation. No model calls or business mutations."""
from __future__ import annotations
import argparse,ctypes,ctypes.wintypes as w,json,os,time
from datetime import datetime,timezone
from pathlib import Path
from web_host_control import AppControl,ControlError,ROOT
from windows_process_owner import _NativeApi,OwnershipUnavailable,process_identity

class MemoryCounters(ctypes.Structure):
    _fields_=[('cb',w.DWORD),('PageFaultCount',w.DWORD)]+[(key,ctypes.c_size_t) for key in
        ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage',
         'QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage')]

def now():return datetime.now(timezone.utc).isoformat()
def resources(pid,expected_creation=None):
    api=_NativeApi();rows=api.snapshot();owned={pid}
    if pid not in rows:raise OwnershipUnavailable('soak_original_owner_not_running')
    for _ in range(len(rows)):
        added={key for key,row in rows.items() if row['parent'] in owned}-owned
        if not added:break
        owned.update(added)
    memory=ctypes.WinDLL('psapi',use_last_error=True).GetProcessMemoryInfo
    memory.argtypes=[w.HANDLE,ctypes.POINTER(MemoryCounters),w.DWORD];memory.restype=w.BOOL
    totals={'processes':0,'private_bytes':0,'working_set_bytes':0,'cpu_seconds':0.0,'racing_processes':0}
    identities={};observed={}
    for target in sorted(owned):
        handle=None
        try:
            handle=api.open(target);created=api.marker(handle)
            if target==pid and expected_creation is not None and created!=expected_creation:
                raise OwnershipUnavailable('soak_original_owner_changed')
            counters=MemoryCounters();counters.cb=ctypes.sizeof(counters)
            values=[w.FILETIME() for _ in range(4)]
            if not memory(handle,ctypes.byref(counters),counters.cb) or not api.kernel.GetProcessTimes(handle,*[ctypes.byref(value) for value in values]):
                raise OwnershipUnavailable('process_resource_sample_unavailable')
            if api.marker(handle)!=created:raise OwnershipUnavailable()
            observed[target]={'created':created,'parent':rows[target]['parent'],
                'private_bytes':counters.PrivateUsage,'working_set_bytes':counters.WorkingSetSize,
                'cpu_seconds':sum(((value.dwHighDateTime<<32)|value.dwLowDateTime)/1e7 for value in values[2:])}
        except OwnershipUnavailable:
            if target==pid:raise
        finally:
            if handle:api.close(handle)
    # A reused parent PID cannot adopt a process born before that parent.
    verified={pid}
    for _ in observed:
        added={target for target,row in observed.items() if row['parent'] in verified and
               row['created']>=observed[row['parent']]['created']}-verified
        if not added:break
        verified.update(added)
    for target in verified:
        row=observed[target];identities[str(target)]=str(row['created']);totals['processes']+=1
        for key in ('private_bytes','working_set_bytes','cpu_seconds'):totals[key]+=row[key]
    totals['racing_processes']=len(owned)-len(verified)
    return {**totals,'identities':identities}

def run(profile,output,seconds,interval,*,inspect_ui=False,expected_root=ROOT):
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    log=output/'samples.jsonl';final=output/'result.json'
    if log.exists() or final.exists():raise ValueError('soak_result_already_exists')
    client=AppControl(profile,expected_root=expected_root);initial=client.state();owner=initial['app_instance_id']
    original_process=process_identity(initial['pid']);expected_creation=int(original_process['CreationFiletime'])
    advertised=client.descriptor.get('process_identity')
    if advertised is not None and str(advertised.get('creation_filetime'))!=str(expected_creation):
        raise OwnershipUnavailable('soak_descriptor_owner_changed')
    started=time.perf_counter()
    report={'state':'running','started_at':now(),'requested_seconds':seconds,'interval_seconds':interval,
            'instance_id':owner,'pid':initial['pid'],'original_process':original_process,
            'loaded_main_sha256':initial['shell']['loaded_main_sha256'],
            'model_calls':0,'business_mutations':0,'samples':0,'failures':[],'control_commands':0}
    previous=None;latencies=[];peak=0;first=None;last=None
    with log.open('x',encoding='utf8') as stream:
        while True:
            began=time.perf_counter();row={'at':now(),'elapsed_seconds':round(began-started,3)}
            try:
                state=client.state();elapsed=time.perf_counter()-began
                if state['app_instance_id']!=owner or state['pid']!=initial['pid']:raise ControlError('soak_original_owner_changed')
                if state['shell']['loaded_main_sha256']!=report['loaded_main_sha256']:raise ControlError('soak_loaded_source_changed')
                sample=resources(state['pid'],expected_creation);latencies.append(elapsed*1000)
                current={'cpu':sample['cpu_seconds'],'time':time.perf_counter(),'identities':sample['identities']}
                same=previous and previous['identities']==sample['identities']
                row.update(state_ms=round(elapsed*1000,3),connected=state['connected'],task_state_ready=state['task_state_ready'],
                    runtime=state['runtime'],pending=state['pending'],task_count=len(state['tasks']),
                    window=state.get('window'),exit=state.get('exit'),
                    diagnostics=state.get('diagnostics'),resources={key:value for key,value in sample.items() if key!='identities'},
                    cpu_percent=round(100*(current['cpu']-previous['cpu'])/(current['time']-previous['time'])/(os.cpu_count() or 1),3) if same else None)
                previous=current;peak=max(peak,sample['private_bytes']);first=first or row;last=row
                if inspect_ui:
                    receipt=client.ui_command('inspect-ui',wait_seconds=5);report['control_commands']+=1
                    row['inspect_state']=receipt['state']
                    if receipt['state']!='completed':raise ControlError('soak_inspect_'+receipt['state'])
            except (ControlError,OwnershipUnavailable,OSError,ValueError) as error:
                row['error']=str(error);report['failures'].append({'at':row['at'],'error':str(error)})
            stream.write(json.dumps(row,ensure_ascii=False)+'\n');stream.flush();report['samples']+=1
            if time.perf_counter()-started>=seconds:break
            time.sleep(min(interval,max(0,seconds-(time.perf_counter()-started))))
    sorted_latencies=sorted(latencies)
    report.update(state='completed' if not report['failures'] else 'completed_with_observed_failures',finished_at=now(),
        actual_seconds=round(time.perf_counter()-started,3),peak_private_bytes=peak,first_sample=first,last_sample=last,
        state_p95_ms=sorted_latencies[min(len(sorted_latencies)-1,int(len(sorted_latencies)*.95))] if sorted_latencies else None)
    final.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({key:report[key] for key in ['state','actual_seconds','samples','control_commands','state_p95_ms','peak_private_bytes']}),flush=True)
    return 0 if not report['failures'] else 2

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',type=Path,default=ROOT/'.local/web-host');parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--expected-root',type=Path,default=ROOT)
    parser.add_argument('--seconds',type=int,default=3600);parser.add_argument('--interval',type=int,default=15)
    parser.add_argument('--inspect-ui',action='store_true');args=parser.parse_args()
    if not 1<=args.seconds<=86400 or not 1<=args.interval<=300:parser.error('duration or interval outside bounded range')
    return run(args.profile,args.output,args.seconds,args.interval,inspect_ui=args.inspect_ui,expected_root=args.expected_root)
if __name__=='__main__':raise SystemExit(main())
