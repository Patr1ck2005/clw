"""Harness binding/HTTP tests; fake transport is not claimed as real model evidence."""
from pathlib import Path
from contextlib import closing
import http.client,json,sys,tempfile,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from harness_state import HarnessState,HarnessError,public
from harness_service import HarnessService
from harness_rpc import RpcFailure
from harness_http import HarnessHTTP
from serve_control_center import create_server

class FakeConnection:
    def __init__(self,root,on_event):self.root=root;self.callback=on_event;self.calls=[];self.alive=False;self.pid=1;self.auth_type='chatgpt';self.unknown_send=False;self.replies=[];self.closed=False
    def start(self):self.alive=True;return {'userAgent':'fixture'}
    def request(self,method,params,timeout=30):
        self.calls.append((method,params))
        if method=='account/read':return {'account':{'type':self.auth_type,'planType':'pro','email':'private@example.invalid'}}
        if method=='config/read':return {'config':{'model':'fixture-model','model_reasoning_effort':'max'}}
        if method in ('thread/start','thread/fork'):return {'thread':{'id':'native-'+uuid.uuid4().hex},'model':'fixture-model'}
        if method=='thread/resume':return {'thread':{'id':params['threadId']}}
        if method=='thread/read':return {'thread':{'id':params['threadId'],'turns':[{'id':'turn-1','status':'completed','items':[{'type':'agentMessage','text':'actual fixture result'}]}]}}
        if method=='turn/start':
            if self.unknown_send:raise RpcFailure('request_timeout',unknown=True)
            self.callback({'method':'turn/started','params':{'threadId':params['threadId'],'turn':{'id':'turn-1','status':'inProgress'}}})
            if getattr(self,'drop_after_event',False):raise RpcFailure('timeout',unknown=True)
            return {'turn':{'id':'turn-1','status':'inProgress'}}
        if method=='turn/interrupt':return {}
        raise AssertionError(method)
    def respond(self,key,result):self.replies.append((key,result))
    def close(self):self.alive=False;self.closed=True

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection)
    def tearDown(self):self.s.close();self.tmp.cleanup()
    def cmd(self,action,data=None,thread=None,key=None):return self.s.command({'request_id':key or str(uuid.uuid4()),'action':action,'data':data or {},**({'thread_id':thread} if thread else {})})
    def new(self,title='test'):return self.cmd('thread.create',{'title':title})['thread']
    def test_connect_does_not_infer_or_expose_account_email(self):
        result=self.cmd('provider.connect');self.assertEqual(result['state'],'completed');self.assertNotIn('private@',json.dumps(result));self.assertNotIn('turn/start',[m for m,p in self.s.connection.calls])
    def test_api_key_auth_never_becomes_hidden_fallback(self):
        def factory(root,cb):c=FakeConnection(root,cb);c.auth_type='apiKey';return c
        self.s.connection_factory=factory
        result=self.cmd('provider.connect');self.assertEqual(result['state'],'rejected');self.assertEqual(result['code'],'codex_chatgpt_login_required_no_api_fallback')
    def test_thread_uses_exact_root_and_preserves_model(self):
        row=self.new();self.assertEqual(row['cwd'],str(self.root));self.assertEqual(row['model'],'fixture-model');self.assertEqual(row['effort'],'max')
        params=[p for m,p in self.s.connection.calls if m=='thread/start'][0];self.assertEqual(params['sandbox'],'workspace-write');self.assertNotIn('model',params)
    def test_real_fork_semantics_not_local_role_play(self):
        parent=self.new();child=self.cmd('thread.fork',{'title':'branch'},parent['id'])['thread'];self.assertEqual(child['parent_id'],parent['id']);self.assertNotEqual(child['native_id'],parent['native_id']);self.assertTrue(any(m=='thread/fork' for m,p in self.s.connection.calls))
    def test_request_replay_never_creates_another_thread(self):
        key=str(uuid.uuid4());a=self.cmd('thread.create',{'title':'same'},key=key);b=self.cmd('thread.create',{'title':'same'},key=key);self.assertEqual(a,b);self.assertEqual(len(self.s.state.listing()),1)
    def test_changed_request_key_is_rejected(self):
        key=str(uuid.uuid4());self.cmd('thread.create',{'title':'a'},key=key)
        with self.assertRaises(HarnessError):self.cmd('thread.create',{'title':'b'},key=key)
    def test_unknown_send_is_kept_without_repeat(self):
        row=self.new();self.s.connection.unknown_send=True;key=str(uuid.uuid4());a=self.cmd('message.send',{'text':'do work'},row['id'],key);b=self.cmd('message.send',{'text':'do work'},row['id'],key)
        self.assertEqual(a,b);self.assertEqual(a['state'],'unknown');self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1);self.assertEqual(self.s.state.thread(row['id'])['status'],'unknown')
    def test_native_started_event_recovers_lost_rpc_reply_without_resend(self):
        row=self.new();self.s.connection.drop_after_event=True;r=self.cmd('message.send',{'text':'original'},row['id']);self.assertEqual(r['state'],'accepted_not_completed');self.assertEqual(r['turn_id'],'turn-1');self.assertEqual(self.s.state.thread(row['id'])['status'],'working');self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1)
    def test_connection_eof_marks_active_unknown_not_complete(self):
        row=self.new();self.cmd('message.send',{'text':'original'},row['id']);self.s.connection.alive=False;self.s.refresh_liveness();self.assertEqual(self.s.state.thread(row['id'])['status'],'unknown');self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1)
    def test_sync_does_not_authorize_replaying_an_unknown_send(self):
        row=self.new();self.s.connection.unknown_send=True;self.cmd('message.send',{'text':'uncertain'},row['id']);self.cmd('thread.sync',thread=row['id']);self.s.connection.unknown_send=False
        result=self.cmd('message.send',{'text':'must not overlap unknown work'},row['id']);self.assertEqual(result['code'],'workspace_has_unresolved_send');self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1)
    def test_message_is_accepted_not_declared_complete(self):
        row=self.new();reply=self.cmd('message.send',{'text':'work'},row['id']);self.assertEqual(reply['state'],'accepted_not_completed');self.assertEqual(self.s.state.thread(row['id'])['status'],'working')
    def test_same_workspace_turns_are_not_concurrent_writers(self):
        a=self.new('a');b=self.new('b');self.cmd('message.send',{'text':'work'},a['id']);r=self.cmd('message.send',{'text':'other'},b['id']);self.assertEqual(r['code'],'workspace_busy_or_unreconciled');self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1)
    def test_busy_rejection_does_not_corrupt_original_turn_state(self):
        row=self.new();self.cmd('message.send',{'text':'original'},row['id']);r=self.cmd('message.send',{'text':'must not duplicate'},row['id']);self.assertEqual(r['code'],'thread_busy_or_unknown');self.assertEqual(self.s.state.thread(row['id'])['status'],'working');self.assertEqual(self.s.state.thread(row['id'])['active_turn'],'turn-1')
    def test_public_delta_and_completion_are_correlated(self):
        row=self.new();self.cmd('message.send',{'text':'work'},row['id'])
        for method,p in [('item/agentMessage/delta',{'itemId':'i1','delta':'hello'}),('item/completed',{'item':{'id':'i1','type':'agentMessage','text':'hello world'}}),('turn/completed',{'turn':{'id':'turn-1','status':'completed'}})]:self.s.on_event({'method':method,'params':{'threadId':row['native_id'],**p}})
        events=self.s.state.events(row['id'])['items'];self.assertIn('assistant_delta',[e['kind'] for e in events]);self.assertEqual(self.s.state.thread(row['id'])['status'],'idle')
    def test_reasoning_and_foreign_events_are_not_exposed(self):
        row=self.new();n=len(self.s.state.events(row['id'])['items']);self.s.on_event({'method':'item/reasoning/textDelta','params':{'threadId':row['native_id'],'delta':'hidden'}});self.s.on_event({'method':'item/agentMessage/delta','params':{'threadId':'foreign','delta':'not ours'}});self.assertEqual(len(self.s.state.events(row['id'])['items']),n)
    def test_stop_ack_is_not_terminal_completion(self):
        row=self.new();self.cmd('message.send',{'text':'work'},row['id']);r=self.cmd('turn.stop',thread=row['id']);self.assertEqual(r['state'],'stop_requested_not_terminal');self.assertEqual(self.s.state.thread(row['id'])['status'],'stopping')
    def test_stop_without_active_turn_does_not_call_provider(self):
        row=self.new();r=self.cmd('turn.stop',thread=row['id']);self.assertEqual(r['code'],'no_observed_active_turn');self.assertNotIn('turn/interrupt',[m for m,p in self.s.connection.calls])
    def test_approval_requires_exact_branch_and_not_auto_approved(self):
        row=self.new();other=self.new();self.s.on_event({'id':51,'method':'item/commandExecution/requestApproval','params':{'threadId':row['native_id'],'command':'test'}})
        self.assertEqual(self.s.connection.replies,[]);a=self.s.pending(row['id'])[0]
        r=self.cmd('approval.respond',{'approval_id':a['approval_id'],'decision':'accept'},other['id']);self.assertEqual(r['state'],'rejected')
        self.cmd('approval.respond',{'approval_id':a['approval_id'],'decision':'decline'},row['id']);self.assertEqual(self.s.connection.replies,[(51,{'decision':'decline'})])
    def test_unsupported_approval_never_default_accepts(self):
        row=self.new();self.s.on_event({'id':8,'method':'future/request','params':{'threadId':row['native_id']}});a=self.s.pending(row['id'])[0];r=self.cmd('approval.respond',{'approval_id':a['approval_id'],'decision':'accept'},row['id']);self.assertEqual(r['code'],'unsupported_approval_type');self.assertFalse(self.s.connection.replies)
    def test_sync_reads_original_without_new_turn(self):
        row=self.new();self.s.state.update(row['id'],status='unknown');r=self.cmd('thread.sync',thread=row['id']);self.assertEqual(r['thread']['status'],'idle');self.assertNotIn('turn/start',[m for m,p in self.s.connection.calls])
    def test_invalid_command_cannot_be_arbitrary_rpc(self):
        with self.assertRaises(HarnessError):self.cmd('run_shell',{'command':'no'})
        self.assertIsNone(self.s.connection)
    def test_root_override_is_rejected(self):
        r=self.cmd('thread.create',{'title':'x','cwd':'C:/other'});self.assertEqual(r['state'],'rejected');self.assertIsNone(self.s.connection)
    def test_restart_retains_identity_and_marks_inflight_unknown(self):
        row=self.new();self.cmd('message.send',{'text':'work'},row['id']);self.s.close();again=HarnessState(self.root/'state/harness.sqlite3');self.assertEqual(again.id,self.s.state.id);self.assertEqual(again.thread(row['id'])['native_id'],row['native_id']);self.assertEqual(again.thread(row['id'])['status'],'unknown')
    def test_only_native_recorded_artifacts_can_be_previewed(self):
        row=self.new();path=self.root/'result.txt';path.write_text('real local text',encoding='utf-8')
        self.s.on_event({'method':'item/completed','params':{'threadId':row['native_id'],'item':{'id':'f1','type':'fileChange','changes':[{'path':str(path),'kind':{'type':'add'}}]}}})
        item=self.s.artifacts(row['id'])['items'][0];result=self.s.artifact(row['id'],item['id']);self.assertEqual(result['text'],'real local text');self.assertEqual(result['bytes'],15)
        with self.assertRaises(HarnessError):self.s.artifact(row['id'],'../../auth.json')
    def test_sensitive_or_outside_native_paths_do_not_allow_preview(self):
        row=self.new();self.s.on_event({'method':'item/completed','params':{'threadId':row['native_id'],'item':{'id':'f1','type':'fileChange','changes':[{'path':str(self.root/'auth.json')},{'path':str(self.root.parent/'outside.txt')}]}}})
        items=self.s.artifacts(row['id'])['items'];self.assertEqual(len(items),1);self.assertFalse(items[0]['previewable'])
        with self.assertRaises(HarnessError):self.s.artifact(row['id'],items[0]['id'])
    def test_credentials_are_redacted_recursively(self):
        result=public({'api_key':'secret','x':['Bearer abcdefghijklmnopqr','wck_abcdefghijklmnop'],'email':'hidden'});self.assertNotIn('secret',json.dumps(result));self.assertNotIn('abcdefghijklmnop',json.dumps(result));self.assertNotIn('email',result)

class HTTPTests(ServiceTests):
    # Inherited service cases also run with a real loopback HTTP server.
    def setUp(self):
        super().setUp();self.server=create_server(0);self.server.harness_api=HarnessHTTP(self.s);self.port=self.server.server_address[1];self.origin=f'http://127.0.0.1:{self.port}';self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();super().tearDown()
    def http(self,path,body=None,headers=None,method=None):
        h={'Origin':self.origin};h.update(headers or {})
        if body is not None:h.update({'Content-Type':'application/json','X-CLW-Intent':self.s.intent})
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
        try:
            conn.request(method or ('POST' if body is not None else 'GET'),path,body=json.dumps(body).encode() if body is not None else None,headers=h);r=conn.getresponse();return r.status,r.read()
        finally:conn.close()
    def test_page_serves_same_origin_assets(self):
        status,body=self.http('/harness.html');self.assertEqual(status,200);self.assertIn('harness-ui.mjs',body.decode())
    def test_foreign_origin_cannot_read_or_command(self):
        status,_=self.http('/api/harness/info',headers={'Origin':'https://evil.invalid'});self.assertEqual(status,403)
    def test_wrong_host_is_rejected(self):
        status,_=self.http('/api/harness/info',headers={'Host':'evil.invalid'});self.assertEqual(status,403)
    def test_missing_intent_cannot_mutate(self):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10);body=json.dumps({'request_id':str(uuid.uuid4()),'action':'provider.connect','data':{}})
        try:conn.request('POST','/api/harness/command',body,{'Origin':self.origin,'Content-Type':'application/json'});r=conn.getresponse();self.assertEqual(r.status,403);r.read()
        finally:conn.close()
        self.assertIsNone(self.s.connection)
    def test_http_send_replay_returns_same_native_turn(self):
        row=self.new();body={'request_id':str(uuid.uuid4()),'action':'message.send','thread_id':row['id'],'data':{'text':'fixture'}}
        a=self.http('/api/harness/command',body);b=self.http('/api/harness/command',body);self.assertEqual(a,b);self.assertEqual(sum(m=='turn/start' for m,p in self.s.connection.calls),1)
    def test_duplicate_query_and_unsupported_path_are_rejected(self):
        self.assertEqual(self.http('/api/harness/events?after=1&after=2')[0],400);self.assertEqual(self.http('/api/harness/execute')[0],404)

if __name__=='__main__':unittest.main(verbosity=2)
