"""Bounded native wire contract tests with local HTTP fixtures, not Host evidence."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,sys,threading,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from communication_bridge import CommunicationBridge,NATIVE_COMMIT
from live_transport import Transport
from task_domain import TaskError

class NativeHandler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));self.server.calls.append((self.path,body))
        if self.headers.get('Authorization')!='Bearer '+self.server.token:self.send_error(403);return
        if self.path=='/api/runtime/status':
            build={'git_commit':self.server.commit,'git_dirty':self.server.dirty,'version':'0.4.1'}
            output={'version':'0.4.1','build':build}
            if self.server.legacy_shape:output={'version':'0.4.1','server':{'build':build}}
            if self.server.malformed_build:output['build']=None
            result={'success':True,'output':output}
        elif getattr(self.server,'tool_error',None):
            status,payload=self.server.tool_error;encoded=json.dumps(payload).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded);return
        elif body['tool']=='list_agent_identities':result={'success':True,'output':{'agents':[{'agent_id':'agent-test','current_controller_generation':1,'production_auto_resume_available':False}]}}
        elif body['tool']=='read_conversation':result={'success':True,'output':{'conversation':{'conversation_id':'conversation-test'},'participants':[{'agent_id':'agent-test'}],'messages':[self.server.message] if self.server.message else []}}
        elif body['tool']=='post_conversation_message':
            p=body['params'];self.server.message={'message_id':'message-test','conversation_id':p['conversation_id'],'body':p['body'],'seq':1,'deliveries':[{'delivery_id':'delivery-test','recipient_agent_id':p['recipient_agent_ids'][0],'state':'queued'}]};result={'success':True,'output':{'message':self.server.message}}
        else:self.send_error(404);return
        encoded=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.server=ThreadingHTTPServer(('127.0.0.1',0),NativeHandler);self.server.token='wck_'+'fixture_only_not_secret'*2;self.server.commit=NATIVE_COMMIT[:12];self.server.calls=[];self.server.message=None
        self.server.dirty=False;self.server.legacy_shape=False;self.server.malformed_build=False
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
        self.bridge=CommunicationBridge(Transport(self.origin,self.server.token),enabled=True)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def item(self):
        route=self.bridge.check_target('agent-test','conversation-test',1)
        return {'route':route,'native_request':{'conversation_id':'conversation-test','body':'original task locator','recipient_agent_ids':['agent-test'],'idempotency_key':'original-persisted-key'}}
    def test_exact_fixed_commit_and_participant_observation(self):
        target=self.bridge.check_target('agent-test','conversation-test',1);self.assertFalse(target['host_auto_resume_verified']);self.assertEqual(target['namespace'],self.bridge.namespace)
    def test_same_semver_old_commit_is_rejected(self):
        self.server.commit='f080c8f3ea70'
        with self.assertRaises(TaskError):self.bridge.check_target('agent-test','conversation-test',1)
        self.assertEqual(len(self.server.calls),1)
    def test_clean_reviewed_liveness_and_original_builds_keep_same_contract(self):
        for commit in (NATIVE_COMMIT,NATIVE_COMMIT[:12],
                       '37098d4624f0000bfab54ad102ecb0df619d7dc6','37098d4624f0'):
            with self.subTest(commit=commit):
                self.server.commit=commit;self.server.calls.clear()
                target=self.bridge.check_target('agent-test','conversation-test',1)
                self.assertEqual(target['agent_id'],'agent-test')
                self.assertEqual([path for path,_ in self.server.calls],
                                 ['/api/runtime/status','/api/tools/call','/api/tools/call'])
                self.assertFalse(any(body.get('tool')=='post_conversation_message' for _,body in self.server.calls))
    def test_actual_pinned_top_level_build_is_required(self):
        self.assertEqual(self.bridge.check_runtime()['build']['git_commit'],NATIVE_COMMIT[:12])
        self.server.legacy_shape=True
        with self.assertRaises(TaskError) as error:self.bridge.check_runtime()
        self.assertEqual(error.exception.code,'communication_version')
    def test_dirty_or_malformed_build_never_passes_same_commit(self):
        self.server.dirty=True
        with self.assertRaises(TaskError):self.bridge.check_runtime()
        self.server.dirty=False;self.server.malformed_build=True
        with self.assertRaises(TaskError):self.bridge.check_runtime()

    def test_generation_and_recipient_mismatch_rejected(self):
        for agent,generation in [('agent-other',1),('agent-test',2),('agent-test',True)]:
            with self.assertRaises(TaskError):self.bridge.check_target(agent,'conversation-test',generation)
    def test_write_is_explicit_not_inherited_from_readonly_connection(self):
        item=self.item();self.bridge.enabled=False
        with self.assertRaises(TaskError):self.bridge.post(item)
        self.assertFalse(any(b.get('tool')=='post_conversation_message' for _,b in self.server.calls))
    def test_single_post_and_exact_receipt_observation(self):
        item=self.item();receipt=self.bridge.post(item);self.assertEqual(receipt['message_id'],'message-test');item['native_receipt']=receipt
        self.server.message['deliveries'][0]['state']='consumed';self.assertEqual(self.bridge.observe(item)['delivery_state'],'consumed')
        self.assertEqual(sum(b.get('tool')=='post_conversation_message' for _,b in self.server.calls),1)
    def test_arbitrary_native_tool_not_exposed(self):
        with self.assertRaises(TaskError):self.bridge.call('run_shell',{'command':'never'})
        self.assertEqual(self.server.calls,[])
    def test_wrong_native_receipt_body_is_not_success(self):
        item=self.item();self.bridge.post(item);self.server.message['body']='different'
        with self.assertRaises(TaskError):self.bridge.project_message(self.server.message,item)
    def test_preflight_failure_explicitly_proves_no_notification_post(self):
        item=self.item();self.server.commit='f080c8f3ea70'
        with self.assertRaises(TaskError) as error:self.bridge.post(item)
        self.assertIs(error.exception.notification_post_not_attempted,True)
        self.assertFalse(any(body.get('tool')=='post_conversation_message' for _,body in self.server.calls))

    def test_403_reports_missing_scope_without_exposing_raw_errors(self):
        self.server.tool_error=(403,{'error':'missing scope communication:read '+self.server.token,'status':403})
        with self.assertRaises(TaskError) as caught:self.bridge.call('list_agent_identities',{'limit':1})
        self.assertEqual(caught.exception.code,'communication_scope_denied');self.assertEqual(caught.exception.native_http_status,403);self.assertEqual(caught.exception.required_scopes,['communication:read']);self.assertNotIn(self.server.token,str(caught.exception));self.assertEqual(len(self.server.calls),1)
    def test_401_and_scope_free_403_are_distinct(self):
        for status,code in [(401,'communication_auth_required'),(403,'communication_access_denied')]:
            self.server.tool_error=(status,{'error':'denied'})
            with self.assertRaises(TaskError) as caught:self.bridge.call('list_agent_identities',{'limit':1})
            self.assertEqual(caught.exception.code,code);self.assertEqual(caught.exception.native_http_status,status);self.assertEqual(caught.exception.required_scopes,[])
    def test_private_credential_does_not_escape_capability_projection(self):
        self.assertNotIn(self.server.token,json.dumps(self.bridge.capability()));self.assertFalse(self.bridge.capability()['model_execution_interface'])

if __name__=='__main__':unittest.main(verbosity=2)
