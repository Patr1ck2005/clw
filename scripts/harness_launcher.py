"""Foreground CLW application supervisor. Does not detach from a Runner Job.

The normal user terminal owns this process; this process owns only the child it
spawned. Kernel locking, exact instance stop, bounded crash restart, source/state
fences. No service installation, system process scans, token reads or model calls.
"""
from __future__ import annotations
import argparse, hashlib, json, os, signal, socket, subprocess, sys, time, uuid, webbrowser, threading
from pathlib import Path
from contextlib import ExitStack
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from product_runtime import FileLease, ProductError, atomic_json, read_json, snapshot_payload, hash_payload, json_bytes
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://127.0.0.1:18944'
BACKOFF=(1,3,9)


def checked_dir(root):
    root=Path(root).resolve();directory=root/'.local/harness-launcher'
    for p in (root/'.local',directory):
        if p.exists() and (p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400):
            raise ProductError('launcher_link_not_allowed')
    return directory


def source_fingerprint(root):
    hashes=hash_payload(snapshot_payload(root))
    config=Path(root)/'config/harness-web-targets.json'
    if config.exists():
        if config.is_symlink() or getattr(config.lstat(),'st_file_attributes',0)&0x400:raise ProductError('launcher_config_link')
        with config.open('rb') as f:data=f.read(131073)
        if len(data)>131072:raise ProductError('launcher_config_too_large')
        hashes['config/harness-web-targets.json']=hashlib.sha256(data).hexdigest()
    return hashlib.sha256(json_bytes(hashes)).hexdigest()


def state_identity(root):
    path=Path(root)/'.local/harness/_clw_state.json'
    if not path.exists():return None
    for p in (path,path.parent,path.parent.parent):
        if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400:raise ProductError('launcher_state_link')
    return read_json(path,4096)['state_id']


def listening():
    s=socket.socket();s.settimeout(1)
    try:return s.connect_ex(('127.0.0.1',18944))==0
    finally:s.close()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*a,**k):raise ProductError('launcher_redirect_rejected')


def owned_health(root,pid,expected_state=None):
    opener=build_opener(ProxyHandler({}),NoRedirect())
    req=Request(ORIGIN+'/api/product/info',headers={'Origin':ORIGIN})
    with opener.open(req,timeout=2) as response:
        raw=response.read(32769)
    if len(raw)>32768:raise ProductError('launcher_health_too_large')
    v=json.loads(raw)
    if v.get('product')!='clw-control-center' or v.get('pid')!=pid or not v.get('state_id'):
        raise ProductError('launcher_health_owner_mismatch')
    # Product identity has no root; ownership combines our Popen pid, retained
    # state identity and the root used to spawn the child, never a guessed PID.
    if expected_state is not None and v['state_id']!=expected_state:raise ProductError('launcher_state_changed')
    return {k:v.get(k) for k in ('pid','state_id','instance_id','version','source_commit')}


def status(root=ROOT):
    directory=checked_dir(root);p=directory/'owner.json'
    if not p.exists():return {'state':'not_started','owner_verified':False}
    value=read_json(p,8192)
    return {**value,'heartbeat_recent':time.time()-value.get('heartbeat',0)<5,
            'owner_verified':False,'note':'Heartbeat is observation, not authority to stop another PID.'}


def request_stop(root=ROOT):
    directory=checked_dir(root);owner=read_json(directory/'owner.json',8192)
    instance=owner.get('instance_id','')
    if not isinstance(instance,str) or len(instance)!=32 or any(c not in '0123456789abcdef' for c in instance):
        raise ProductError('launcher_instance_invalid')
    atomic_json(directory/'stop.json',{'instance_id':instance})
    return {'state':'stop_requested','instance_id':instance,'process_killed':False}


def stop_requested(directory,instance):
    p=directory/'stop.json'
    if not p.exists():return False
    return read_json(p,4096).get('instance_id')==instance


def stop_child(child,grace=5):
    if child.poll() is not None:return
    try:
        if os.name=='nt':child.send_signal(signal.CTRL_BREAK_EVENT)
        else:child.send_signal(signal.SIGINT)
        child.wait(timeout=grace)
    except (OSError,subprocess.TimeoutExpired):
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=grace)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=grace)


class BoundedLog:
    """Drain child pipe without blocking it; retain at most 2 MiB per launch."""
    def __init__(self,pipe,stream,maximum=2*1024*1024):
        self.pipe,self.stream,self.maximum=pipe,stream,maximum;self.kept=0;self.dropped=0
        self.thread=threading.Thread(target=self.drain,daemon=True,name='clw-bounded-child-log');self.thread.start()
    def drain(self):
        try:
            while True:
                data=getattr(self.pipe,'read1',self.pipe.read)(8192)
                if not data:break
                n=min(len(data),max(0,self.maximum-self.kept))
                if n:self.stream.write(data[:n]);self.stream.flush();self.kept+=n
                self.dropped+=len(data)-n
        except (OSError,ValueError):pass
    def finish(self):
        self.thread.join(timeout=3)
        if not self.thread.is_alive():self.pipe.close()
        return {'retained_bytes':self.kept,'dropped_bytes':self.dropped,'drain_finished':not self.thread.is_alive()}


def restart_decision(code,restarts,same_source,same_state,stopped):
    if stopped:return 'stopped'
    if code==0:return 'normal_exit'
    if not same_source:return 'source_changed_manual_restart'
    if not same_state:return 'state_changed_no_restart'
    if restarts>=len(BACKOFF):return 'crash_budget_exhausted'
    return 'restart'


def supervise(root=ROOT,open_browser=False,*,popen=subprocess.Popen,clock=time.monotonic,sleep=time.sleep,
              port_check=listening,health=owned_health,fingerprint=source_fingerprint,identity=state_identity):
    root=Path(root).resolve();directory=checked_dir(root);directory.mkdir(parents=True,exist_ok=True)
    child=None;logger=None;instance=uuid.uuid4().hex;restarts=0;opened=False
    def write(state,**more):
        atomic_json(directory/'owner.json',dict(format='clw.launcher-owner.v1',instance_id=instance,
            supervisor_pid=os.getpid(),child_pid=child.pid if child else None,root=str(root),
            state=state,restarts=restarts,heartbeat=time.time(),runner_deadline_bypassed=False,
            log_dropped_bytes=logger.dropped if logger else 0,**more))
    with FileLease(directory/'supervisor.lock'):
        if port_check():
            write('port_already_owned_no_process_stopped');return 2
        original_source=fingerprint(root);original_state=identity(root)
        try:
            while True:
                if stop_requested(directory,instance):write('stopped');return 0
                if port_check():write('port_changed_no_process_stopped');return 2
                if fingerprint(root)!=original_source:write('source_changed_manual_restart');return 2
                if identity(root)!=original_state:write('state_changed_no_restart');return 2
                log=directory/('app-'+instance+'-'+str(restarts)+'.log')
                if log.exists():raise ProductError('launcher_log_collision')
                with ExitStack() as log_context:
                    stream=log_context.enter_context(log.open('xb'))
                    cmd=[sys.executable,'-X','utf8','-B',str(root/'scripts/serve_harness.py'),'--launch-owner','supervised-terminal']
                    kwargs=dict(cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
                    if os.name=='nt':kwargs['creationflags']=subprocess.CREATE_NEW_PROCESS_GROUP
                    child=popen(cmd,**kwargs)
                    logger=BoundedLog(child.stdout,stream) if getattr(child,'stdout',None) is not None else None
                    if logger:log_context.callback(logger.finish)
                    write('starting');deadline=clock()+20;ready=False;last_heartbeat=clock()
                    while child.poll() is None:
                        if stop_requested(directory,instance):stop_child(child);write('stopped');return 0
                        if not ready:
                            try:
                                seen=health(root,child.pid,original_state)
                                if original_state is None:original_state=seen['state_id']
                                ready=True;write('ready',child_instance=seen['instance_id'])
                                if open_browser and not opened:webbrowser.open(ORIGIN+'/harness.html');opened=True
                            except ProductError:
                                stop_child(child);write('identity_mismatch_no_restart');return 2
                            except (OSError,ValueError):pass
                            if not ready and clock()>=deadline:
                                stop_child(child);write('startup_health_failed_no_restart');return 2
                        if clock()-last_heartbeat>=2:
                            write('ready' if ready else 'starting');last_heartbeat=clock()
                        sleep(.25)
                    code=child.returncode
                decision=restart_decision(code,restarts,fingerprint(root)==original_source,identity(root)==original_state,stop_requested(directory,instance))
                if decision!='restart':write(decision,last_exit_code=code);return 0 if code==0 or decision=='stopped' else 2
                write('crash_backoff',last_exit_code=code)
                until=clock()+BACKOFF[restarts]
                while clock()<until:
                    if stop_requested(directory,instance):write('stopped');return 0
                    sleep(min(.25,until-clock()))
                restarts+=1
        except KeyboardInterrupt:
            if child:stop_child(child)
            write('stopped');return 0
        finally:
            if child and child.poll() is None:stop_child(child)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('run','status','stop'))
    parser.add_argument('--open',action='store_true');a=parser.parse_args()
    if a.action=='run':return supervise(open_browser=a.open)
    print(json.dumps(status() if a.action=='status' else request_stop(),ensure_ascii=False));return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError):
        print(json.dumps({'state':'launcher_error_no_replay','model_calls':0}));raise SystemExit(2)
