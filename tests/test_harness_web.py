"""Isolated native-Web tests: fake communication only, no real Host/model."""
from pathlib import Path
import json,sys,tempfile,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_state import HarnessError
from task_domain import TaskError
from test_harness_service import FakeConnection
A='wc_dagent_abcdefghijklmnop';C='wc_conv_abcdefghijklmnop'
TARGET={'id':'main','title':'Web','agent_id':A,'conversation_id':C,'controller_generation':4,'project':'test','session_id':'wc_sess_abcdefghijklmnop'}
CONFIG={'schema_version':1,'targets':[TARGET]}
class FakeBridge:
    namespace='fixture-native'
    def __init__(self):self.messages=[];self.posts=[];self.enabled=False;self.denied=False;self.lost=False;self.checks=0;self.bad_identity=False
    def check_runtime(self):self.checks+=1;return {}
    def check_target(self,a,c,g):
        self.checks+=1
        if self.denied:
            e=TaskError('communication_scope_denied','fixture',503);e.native_http_status=403;e.required_scopes=['communication:read'];raise e
        if self.bad_identity:raise TaskError('communication_identity','fixture',409)
        assert (a,c,g)==(A,C,4)
        return {'agent_id':a,'conversation_id':c,'controller_generation':g,'namespace':self.namespace,'native_host_available':True}
    def post(self,item):
        self.posts.append(item);n=len(self.messages)+1
        m={'message_id':'wc_cmsg_'+str(n).zfill(16),'seq':n,'conversation_id':C,'body':item['native_request']['body'],'author':{'participant_kind':'human','agent_id':None},'reply_to':None};self.messages.append(m)
        if self.lost:raise TaskError('communication_unknown','fixture',503)
        return {'message_id':m['message_id'],'seq':n,'delivery_id':'wc_delivery_abcdefghijklmnop','delivery_state':'queued'}
    def call(self,tool,params):
        assert tool=='read_conversation'
        return {'conversation':{'conversation_id':C},'messages':[m for m in self.messages if m['seq']>params['after_seq']][:50],'next_after_seq':None}
class WebTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.bridge=FakeBridge();self.s=self.service()
    def service(self):return HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=CONFIG,web_bridge=self.bridge)
    def tearDown(self):self.s.close();self.tmp.cleanup()
    def cmd(self,action,data=None,row=None,key=None):return self.s.command({'request_id':key or str(uuid.uuid4()),'action':action,'data':data or {},**({'thread_id':row['id']} if row else {})})
    def attach(self):return self.cmd('web.attach',{'target_id':'main','confirm':True})['thread']
    def send(self,row,text='test',key=None):return self.cmd('message.send',{'text':text},row,key)
    def sync(self,row):return self.cmd('thread.sync',row=row)
    def reply(self,r,status='completed',**kw):
        body={'format':'clw.web.reply.v1','store_id':self.s.state.id,'request_id':r['request_id'],'status':status,'text':'reply <script>literal</script>'};body.update(kw.pop('body',{}));n=len(self.bridge.messages)+1
        m={'message_id':'wc_cmsg_'+str(n).zfill(16),'seq':n,'conversation_id':C,'reply_to':r['native_receipt']['message_id'],'author':{'agent_id':A,'participant_kind':'agent'},'body':json.dumps(body)};m.update(kw);self.bridge.messages.append(m)
    def test_attach_without_codex_or_model(self):
        row=self.attach();self.assertEqual(row['provider'],'native_web');self.assertIsNone(self.s.connection);self.assertEqual(self.bridge.posts,[])
    def test_explicit_target_and_consent(self):
        for d in [{'target_id':'main','confirm':False},{'target_id':'other','confirm':True}]:self.assertEqual(self.cmd('web.attach',d)['state'],'rejected')
        self.assertEqual(self.s.state.listing(),[])
    def test_scope_denied_before_any_binding(self):
        self.bridge.denied=True;self.assertEqual(self.cmd('web.attach',{'target_id':'main','confirm':True})['state'],'rejected');self.assertEqual(self.s.state.listing(),[]);self.assertEqual(self.bridge.posts,[])
    def test_wrong_principal_no_substitution(self):
        self.bridge.bad_identity=True;self.assertEqual(self.cmd('web.attach',{'target_id':'main','confirm':True})['code'],'communication_identity');self.assertEqual(self.s.state.listing(),[])
    def test_long_request_small_native_notice(self):
        row=self.attach();text='完整要求'*2000;r=self.send(row,text);self.assertEqual(r['state'],'message_posted_not_completed');self.assertLessEqual(len(self.bridge.posts[0]['native_request']['body'].encode()),4096);self.assertEqual(self.s.web.request(r['request_id'])['text'],text)
    def test_duplicate_send_no_second_post(self):
        row=self.attach();key=str(uuid.uuid4());a=self.send(row,key=key);self.assertEqual(a,self.send(row,key=key));self.assertEqual(len(self.bridge.posts),1)
        with self.assertRaises(HarnessError):self.send(row,'changed',key)
    def test_delivery_is_not_completion(self):
        row=self.attach();self.send(row);self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'web_waiting')
    def test_signed_reply_and_dedup(self):
        row=self.attach();r=self.send(row);self.reply(r);self.sync(row);self.sync(row);ev=self.s.state.events(row['id'])['items'];self.assertEqual(sum(e['kind']=='assistant_message' for e in ev),1);self.assertEqual(self.s.state.thread(row['id'])['status'],'idle')
    def test_progress_and_final(self):
        row=self.attach();r=self.send(row);self.reply(r,'progress');self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'web_processing');self.assertEqual(self.send(row,'second')['state'],'rejected');self.reply(r);self.sync(row);self.assertEqual(self.s.web.pending(),[])
    def test_blocked_not_accepted(self):
        row=self.attach();r=self.send(row);self.reply(r,'blocked');self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'error')
    def test_foreign_agent_human_wrong_parent_store_request_ignored(self):
        row=self.attach();r=self.send(row)
        for kw in [{'author':{'agent_id':'foreign','participant_kind':'agent'}},{'author':{'agent_id':A,'participant_kind':'human'}},{'reply_to':'foreign'},{'body':{'store_id':'foreign'}},{'body':{'request_id':'foreign'}}]:self.reply(r,**kw)
        self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'web_waiting')
    def test_unknown_no_resend_or_inference_from_same_body(self):
        row=self.attach();self.bridge.lost=True;key=str(uuid.uuid4());a=self.send(row,key=key);self.assertEqual(a['state'],'unknown');self.assertEqual(a,self.send(row,key=key));self.sync(row);self.assertEqual(len(self.bridge.posts),1);self.assertEqual(self.s.state.thread(row['id'])['status'],'unknown')
        with self.assertRaises(HarnessError):self.s.web.request(key)
    def test_pending_web_blocks_codex_writer(self):
        row=self.attach();self.send(row);code=self.cmd('thread.create',{'title':'codex'})['thread'];self.assertEqual(self.send(code)['code'],'workspace_busy_or_unreconciled');self.assertFalse(any(m=='turn/start' for m,p in self.s.connection.calls))
    def test_pending_codex_blocks_web_writer(self):
        row=self.attach();code=self.cmd('thread.create',{'title':'codex'})['thread'];self.send(code);self.assertEqual(self.send(row)['code'],'workspace_busy_or_unreconciled');self.assertEqual(self.bridge.posts,[])
    def test_no_fake_interrupt_fork_steer(self):
        row=self.attach()
        for action in ['turn.stop','thread.fork','message.steer']:self.assertEqual(self.cmd(action,row=row)['code'],'native_web_action_not_supported_no_fallback')
        self.assertIsNone(self.s.connection)
    def test_codex_eof_keeps_web_state(self):
        row=self.attach();r=self.send(row);self.reply(r,'progress');self.sync(row);self.s.connect();self.s.connection.alive=False;self.s.refresh_liveness();self.assertEqual(self.s.state.thread(row['id'])['status'],'web_processing')
    def test_denial_latch_and_explicit_restored_probe(self):
        self.bridge.denied=True;self.assertEqual(self.cmd('web.probe')['web']['status'],'blocked');n=self.bridge.checks;self.s.native_diagnostics();self.cmd('web.probe');self.assertEqual(n,self.bridge.checks);self.bridge.denied=False;self.assertEqual(self.cmd('web.probe',{'authorization_changed':True})['web']['status'],'read_authorized');self.assertEqual(self.bridge.posts,[])
    def test_namespace_change_no_retarget(self):
        row=self.attach();self.bridge.namespace='different';self.assertEqual(self.send(row)['code'],'web_connection_changed_reauthorize_binding');self.assertEqual(self.bridge.posts,[])
    def test_restart_original_store_and_native_request(self):
        row=self.attach();r=self.send(row);store=self.s.state.id;self.s.close();self.s=self.service();self.assertEqual(self.s.state.id,store);self.assertEqual(self.s.web.request(r['request_id'])['text'],'test');self.reply(r);self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'idle')
    def test_old_reply_cannot_finish_new_request(self):
        row=self.attach();old=self.send(row);self.reply(old);self.sync(row);self.send(row,'second');self.reply(old);self.sync(row);self.assertEqual(self.s.state.thread(row['id'])['status'],'web_waiting')
    def test_binding_reused_not_duplicate(self):
        row=self.attach();self.assertEqual(self.attach()['id'],row['id']);self.assertEqual(len(self.s.state.listing()),1)
    def test_scope_revocation_after_binding_is_latched(self):
        row=self.attach();self.bridge.denied=True;r=self.send(row);self.assertEqual(r['code'],'communication_scope_denied');self.assertTrue(self.s.web.denied);self.assertEqual(self.bridge.posts,[])
    def test_malformed_reply_page_rolls_back_cursor_and_events(self):
        row=self.attach();r=self.send(row);self.reply(r);original=self.bridge.call
        def bad(tool,params):
            page=original(tool,params);page['messages'].append({'seq':1,'conversation_id':C});return page
        self.bridge.call=bad;self.assertEqual(self.sync(row)['state'],'unknown');self.assertEqual(self.s.state.thread(row['id'])['status'],'web_waiting')
        self.bridge.call=original;self.sync(row);self.assertEqual(sum(e['kind']=='assistant_message' for e in self.s.state.events(row['id'])['items']),1)
    def test_denial_survives_application_restart(self):
        self.bridge.denied=True;self.cmd('web.probe');self.s.close();self.s=self.service();n=self.bridge.checks;self.cmd('web.probe');self.assertEqual(n,self.bridge.checks)
    def test_closed_observer_cannot_commit_late_reply(self):
        row=self.attach();r=self.send(row);self.reply(r);self.s.web.closed=True;self.assertEqual(self.sync(row)['state'],'rejected');self.assertEqual(self.s.state.thread(row['id'])['status'],'web_waiting')
    def test_original_request_context_not_replaced_by_updated_config(self):
        row=self.attach();r=self.send(row);self.s.web.targets['main']['session_id']='different-session';self.s.web.targets['main']['project']='different-project'
        packet=self.s.web.request(r['request_id']);self.assertEqual(packet['session_id'],TARGET['session_id']);self.assertEqual(packet['project'],TARGET['project'])
    def test_failed_reauthorization_does_not_clear_prior_denial(self):
        self.bridge.denied=True;self.cmd('web.probe')
        def transient(*a):raise TaskError('communication_unavailable','fixture',503)
        self.bridge.check_target=transient;self.cmd('web.probe',{'authorization_changed':True});self.assertTrue(self.s.web.denied)
if __name__=='__main__':unittest.main(verbosity=2)
