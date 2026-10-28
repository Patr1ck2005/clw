"""Explicit local process side of the ChatGPT Web Host bridge.
No native PAT, no Codex, no browser cookie, no model calls. Never print local keys.
A wait only observes a queued request; the actual resumed model claims and replies.
"""
from __future__ import annotations
from pathlib import Path
import argparse,json,sys,time,uuid
from urllib.error import HTTPError,URLError
from urllib.request import Request,build_opener,ProxyHandler,HTTPRedirectHandler
from harness_host import read_local_key
from harness_state import HarnessError,public,require
from task_worker import file_bytes
from live_transport import validate_origin
from harness_handoff import wait_for_results
ROOT=Path(__file__).resolve().parents[1]
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise HarnessError('host_redirect_rejected',403)
class Client:
    def __init__(self,origin,state_dir,expected_store,target,session):
        self.origin=validate_origin(origin);self.key=read_local_key(state_dir)
        self.store,self.target,self.session=expected_store,target,session
        self.opener=build_opener(ProxyHandler({}),NoRedirect())
    def call(self,action,**data):
        body={'action':action,'store_id':self.store,'target_id':self.target,'session_id':self.session,**data}
        request=Request(self.origin+'/api/harness/host-control',data=json.dumps(body,ensure_ascii=False).encode('utf-8'),headers={'Origin':self.origin,'Content-Type':'application/json','X-CLW-Host':self.key})
        try:
            with self.opener.open(request,timeout=12) as response:
                require(response.headers.get_content_type()=='application/json','host_response_type',502);raw=response.read(262145)
        except HTTPError as exc:
            status=exc.code;raw=exc.read(1024);exc.close()
            try:code=json.loads(raw).get('code','host_request_rejected')
            except ValueError:code='host_request_rejected'
            raise HarnessError(code,status) from None
        require(len(raw)<=262144,'host_response_too_large',502)
        result=json.loads(raw);require(result.get('success') is True,'host_unconfirmed_result',502);return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=('register','wait','claim','read','reply','recover','join','branches','delegate','yield','results','result','wait-results','control-code','control-adopt','control-disable','control-receive','control-status'))
    p.add_argument('--origin',default='http://127.0.0.1:18944');p.add_argument('--state-dir',type=Path,default=ROOT/'.local/harness')
    p.add_argument('--store-id',required=True);p.add_argument('--target',required=True);p.add_argument('--session-id',required=True)
    p.add_argument('--request-id');p.add_argument('--claim-id');p.add_argument('--reply-id');p.add_argument('--text-file')
    p.add_argument('--text',help='Public reply text for read-only workers; mutually exclusive with --text-file.')
    p.add_argument('--text-stdin',action='store_true',help='UTF-8 public reply from bounded stdin; does not write a worker file.')
    p.add_argument('--workspace-root',type=Path,help='Explicit registered execution root for a reply file; validated against original request metadata.')
    p.add_argument('--recovery-id');p.add_argument('--attempt-id')
    p.add_argument('--model-label');p.add_argument('--effort-label')
    p.add_argument('--parent-target');p.add_argument('--title');p.add_argument('--confirm',action='store_true')
    p.add_argument('--child-target');p.add_argument('--delegation-id');p.add_argument('--after-seq',type=int,default=0)
    p.add_argument('--status',choices=('progress','completed','blocked','cancelled'),default='completed')
    p.add_argument('--wait-key');p.add_argument('--timeout-secs',type=int,default=3600)
    a=p.parse_args();require(a.state_dir.resolve()==(ROOT/'.local/harness').resolve(),'explicit_product_state_required',403)
    c=Client(a.origin,a.state_dir,a.store_id,a.target,a.session_id)
    if a.action=='control-code':
        result=c.call(a.action,confirm=a.confirm,model_label=a.model_label,effort_label=a.effort_label)
    elif a.action=='control-adopt':result=c.call(a.action,confirm=a.confirm,request_id=a.request_id)
    elif a.action=='control-disable':result=c.call(a.action,confirm=a.confirm)
    elif a.action=='control-receive':result=c.call(a.action,attempt_id=a.attempt_id)
    elif a.action=='control-status':result=c.call(a.action)
    elif a.action=='register':result=c.call('register',confirm=True)
    elif a.action=='recover':
        require(bool(a.request_id and a.recovery_id),'recovery_identity_required')
        result=c.call('recover',request_id=a.request_id,recovery_id=a.recovery_id)
    elif a.action in ('claim','read'):
        require(bool(a.request_id),'request_id_required')
        result=c.call(a.action,request_id=a.request_id,**({'claim_id':a.claim_id} if a.action=='claim' else {}))
    elif a.action=='reply':
        require(bool(a.request_id and a.claim_id and a.reply_id) and sum([a.text_file is not None,a.text is not None,a.text_stdin])==1,'reply_identity_required')
        if a.text_stdin:
            encoded=sys.stdin.buffer.read(128*1024+1);require(len(encoded)<=128*1024,'reply_text_too_large');text=encoded.decode('utf-8-sig');require(len(text)<=48000,'reply_text_too_large')
        elif a.text is not None:
            require(len(a.text)<=48000,'reply_text_too_large');text=a.text
        else:
            base=ROOT
            if a.workspace_root is not None:
                context=c.call('read',request_id=a.request_id).get('execution_context')
                require(context and a.workspace_root.resolve()==Path(context['root']).resolve(),'host_reply_scope_mismatch',403)
                base=a.workspace_root
            text=file_bytes(base,a.text_file,128*1024).decode('utf-8-sig')
        result=c.call('reply',request_id=a.request_id,claim_id=a.claim_id,reply_id=a.reply_id,status=a.status,text=text)
    elif a.action=='join':
        require(bool(a.confirm and a.parent_target and a.title),'explicit_independent_branch_required')
        result=c.call('join',parent_target_id=a.parent_target,title=a.title,confirm=True)
    elif a.action=='branches':result=c.call('branches')
    elif a.action=='wait-results':
        require(bool(a.request_id and a.claim_id),'original_parent_claim_required')
        result=wait_for_results(c,a.request_id,a.claim_id,a.timeout_secs)
    elif a.action in ('delegate','yield','results','result'):
        require(bool(a.request_id and a.claim_id),'original_parent_claim_required')
        data={'request_id':a.request_id,'claim_id':a.claim_id}
        if a.action=='delegate':
            require(bool(a.child_target and a.delegation_id and a.text_file),'explicit_child_input_required')
            data.update(child_target_id=a.child_target,delegation_id=a.delegation_id,text=file_bytes(ROOT,a.text_file,96*1024).decode('utf-8-sig'))
        elif a.action=='result':
            require(bool(a.delegation_id) and a.after_seq>=0,'exact_child_result_required')
            data.update(delegation_id=a.delegation_id,after_seq=a.after_seq)
        result=c.call(a.action,**data)
    else:
        require(a.wait_key is not None and 1<=a.timeout_secs<=604800,'bounded_wait_identity_required')
        deadline=time.monotonic()+a.timeout_secs;failures=0
        try:
            while True:
                if time.monotonic()>=deadline:
                    result={'status':'wait_expired_without_request','request_claimed':False,'no_model_work':True};break
                try:result=c.call('poll',wait_key=a.wait_key);failures=0
                except (OSError,URLError):
                    failures+=1
                    if failures>=3:raise HarnessError('host_wait_connection_lost_no_replay',503) from None
                    time.sleep(min(2**failures,8));continue
                if result['available']:
                    result['continuation']='Actual receiver: read docs/harness/HOST_RECEIVER.md; reconcile this exact successful Job and original request, then claim once. The watcher did not claim or prove a Host turn. Do not re-arm a successful wait. MCP App presentation must use its direct callable in the receiving conversation, not JSON/text returned by a gateway or code wrapper.';break
                time.sleep(.5)
        finally:
            try:c.call('release-wait',wait_key=a.wait_key)
            except Exception:pass  # Lease expires; never repeat a request or cancel model work.
    print(json.dumps(public(result),ensure_ascii=False),flush=True)
    return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except (HarnessError,ValueError,OSError) as exc:
        print(json.dumps({'success':False,'code':getattr(exc,'code','host_client_failed'),'request_replayed':False}),flush=True);raise SystemExit(2)
