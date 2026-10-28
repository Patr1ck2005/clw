"""Recovery fixtures: no real ChatGPT, browser login, or model calls."""
from pathlib import Path
from contextlib import closing
from http.client import HTTPConnection
import copy,http.client,json,sys,tempfile,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_state import HarnessError,public
from harness_host import read_local_key
from harness_recovery import Recovery,digest,CONTINUATION_SENTENCE,continuation_prompt
from harness_http import HarnessHTTP
from serve_control_center import create_server
from test_harness_service import FakeConnection
from test_harness_web import CONFIG,FakeBridge

ORIGIN='chrome-extension://'+'a'*32
CHAT='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012'
class RecoveryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.now=1000.
  self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=copy.deepcopy(CONFIG),web_bridge=FakeBridge())
  self.h=self.s.host_bridge;self.r=self.h.recovery;self.r.clock=lambda:self.now;self.h.clock=lambda:self.now
  self.key=read_local_key(self.root/'state');self.session=CONFIG['targets'][0]['session_id']
  self.thread=self.private('register',confirm=True)['thread'];self.req=self.cmd('message.send',{'text':'original'})['request_id']
  self.token=self.pair()['recovery_token']
 def tearDown(self):self.s.close();self.tmp.cleanup()
 def private(self,action,**x):return self.h.private(self.key,dict(action=action,store_id=self.s.state.id,target_id='main',session_id=self.session,**x))
 def cmd(self,action,data=None):return self.s.command(dict(request_id=str(uuid.uuid4()),action=action,data=data or {},thread_id=self.thread['id']))
 def pair(self):
  code=self.r.pairing_code(self.thread['id'])['pair_code'];return self.r.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=CHAT))
 def wire(self,action,**x):return self.r.wire(ORIGIN,self.token,dict(action=action,chat_url=CHAT,**x))
 def obs(self,kind='cannot_think',failure='one',**x):
  data=dict(request_id=self.req,kind=kind,failure_key=digest(failure),user_key=digest('user'),safe=True);data.update(x);return self.wire('observe',**data)
 def offer(self,failure='one'):
  self.obs(failure=failure);self.now+=130;return self.obs(failure=failure)
 def due(self,failure='one'):
  first=self.obs(failure=failure);self.now+=first.get('after_seconds',15);return self.obs(failure=failure)
 def dispatch(self,o):return self.wire('dispatch',request_id=self.req,attempt_id=o['attempt_id'])
 def test_pair_scope_cannot_claim_reply_or_read_task(self):
  self.assertNotIn('text',self.wire('status'));self.assertNotIn(self.key,json.dumps(self.r.snapshot(self.thread['id'])))
  for action in ('claim','reply','execute','read'):
   with self.assertRaises(HarnessError):self.wire(action)
 def test_origin_chat_token_are_independently_fenced(self):
  for origin,token,url in [('https://evil.invalid',self.token,CHAT),(ORIGIN,'bad',CHAT),(ORIGIN,self.token,CHAT+'x')]:
   with self.assertRaises(HarnessError):self.r.wire(origin,token,dict(action='status',chat_url=url))
 def test_pair_code_is_short_lived_once_and_exact_chat(self):
  code=self.r.pairing_code(self.thread['id'])['pair_code'];self.now+=121
  with self.assertRaises(HarnessError):self.r.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=CHAT))
  for url in ('https://chatgpt.com/','https://evil.invalid/c/1234567890123456'):
   code=self.r.pairing_code(self.thread['id'])['pair_code']
   with self.assertRaises(HarnessError):self.r.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=url))
 def test_silence_generating_hidden_draft_never_retries(self):
  for kind in ('idle','generating','draft','unsupported','hidden'):
   self.now+=1000000/6
   # Keep pairing unexpired to test policy, not expiry.
   with closing(self.s.state.connect()) as db:db.execute('UPDATE recovery_peers SET expires=?',(self.now+100,));db.commit()
   self.assertEqual(self.obs(kind)['decision'],'wait')
  self.assertEqual(self.r.snapshot(self.thread['id'])['attempts'],[])
 def test_explicit_error_uses_backoff_and_fixed_original_prompt(self):
  a=self.obs();self.assertEqual(a['after_seconds'],15);self.now+=15;o=self.obs()
  self.assertEqual(o['decision'],'offer');self.assertIn(self.req,o['prompt']);self.assertTrue(o['prompt'].startswith(CONTINUATION_SENTENCE));self.assertIn(self.session,o['prompt'])
  self.assertIn('沿用本对话原连接器。',o['prompt']);self.assertNotIn('@Local-MCP',o['prompt'])
 def test_short_continuation_uses_only_known_account_connector(self):
  for account,reference in (('A','@Local-MCP'),('B','@Local-MCP-B'),(None,'沿用本对话原连接器。'),('unknown','沿用本对话原连接器。')):
   self.assertEqual(continuation_prompt(account),CONTINUATION_SENTENCE+'\n'+reference)
 def test_generation_failed_short_continuation_keeps_original_ack_identity(self):
  claim='claim-'+uuid.uuid4().hex;self.private('claim',request_id=self.req,claim_id=claim)
  first=self.obs(kind='generation_failed');self.assertEqual(first['after_seconds'],15);self.now+=15
  offer=self.obs(kind='generation_failed');self.assertEqual(offer['decision'],'offer')
  self.assertIn('--request-id '+self.req,offer['prompt']);self.assertIn('--recovery-id '+offer['attempt_id'],offer['prompt'])
  self.assertIn('--session-id '+self.session,offer['prompt']);self.assertNotIn('--- 原请求 ---',offer['prompt'])
  self.assertTrue(self.dispatch(offer)['dispatch'])
  recovered=self.private('recover',request_id=self.req,recovery_id=offer['attempt_id'])
  self.assertEqual(recovered['original_claim_id'],claim);self.assertEqual(recovered['request_id'],self.req)
  self.assertTrue(recovered['already_claimed']);self.assertEqual(recovered['phase'],'processing')
  with closing(self.s.state.connect()) as db:
   self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(self.thread['id'],)).fetchone()[0],1)
 def test_unsafe_page_never_schedules(self):
  self.assertEqual(self.obs(safe=False)['decision'],'wait');self.assertFalse(self.r.snapshot(self.thread['id'])['attempts'])
 def test_exact_prompt_dispatch_once(self):
  o=self.due();self.assertTrue(self.dispatch(o)['dispatch'])
  with self.assertRaises(HarnessError):self.dispatch(o)
  self.assertEqual(self.obs()['reason'],'same_failure_already_handled')
 def test_unknown_click_never_replayed_even_new_error(self):
  o=self.due();self.dispatch(o);self.wire('finish',attempt_id=o['attempt_id'],result='unknown')
  self.assertEqual(self.obs(failure='different')['reason'],'previous_dispatch_unknown_no_replay')
 def test_max_three_prompts_per_original_request(self):
  for i,delay in enumerate((15,45,120)):
   self.assertEqual(self.obs(failure=str(i))['after_seconds'],delay);self.now+=delay
   o=self.obs(failure=str(i));self.dispatch(o);self.wire('finish',attempt_id=o['attempt_id'],result='sent')
  self.assertEqual(self.obs(failure='four')['reason'],'recovery_budget_exhausted')
 def test_same_failure_no_resend_after_successful_click(self):
  o=self.due();self.dispatch(o);self.wire('finish',attempt_id=o['attempt_id'],result='sent');self.now+=30
  self.assertEqual(self.obs()['reason'],'same_failure_already_handled')
 def test_new_user_message_after_detection_disables(self):
  self.obs();self.now+=15;self.assertEqual(self.obs(user_key=digest('new'))['decision'],'disabled')
 def test_known_user_or_authorization_stops_are_not_retried(self):
  for kind in ('user_stopped','new_user_input','login_required','rate_limited','safety_denied'):
   self.token=self.pair()['recovery_token'];self.assertEqual(self.obs(kind)['decision'],'disabled')
   with self.assertRaises(HarnessError):self.wire('status')
 def test_pause_between_offer_and_dispatch_prevents_send(self):
  o=self.due();self.h.pause(self.thread['id'],False)
  with self.assertRaises(HarnessError):self.dispatch(o)
 def test_completion_between_offer_and_dispatch_prevents_send(self):
  o=self.due();claim='claim-'+uuid.uuid4().hex;self.private('claim',request_id=self.req,claim_id=claim)
  self.private('reply',request_id=self.req,claim_id=claim,reply_id='reply-'+uuid.uuid4().hex,status='completed',text='fixture')
  with self.assertRaises(HarnessError):self.dispatch(o)
 def test_original_claim_preserved_on_recovery_ack(self):
  claim='claim-'+uuid.uuid4().hex;self.private('claim',request_id=self.req,claim_id=claim);o=self.due();self.dispatch(o)
  r=self.private('recover',request_id=self.req,recovery_id=o['attempt_id']);self.assertEqual(r['original_claim_id'],claim);self.assertEqual(r['phase'],'processing')
  self.assertTrue(self.private('claim',request_id=self.req,claim_id=claim)['already_claimed'])
 def test_unclaimed_recovery_does_not_claim_itself(self):
  o=self.due();self.dispatch(o);r=self.private('recover',request_id=self.req,recovery_id=o['attempt_id']);self.assertIsNone(r['original_claim_id']);self.assertEqual(r['phase'],'queued')
 def test_only_private_model_path_acknowledges_not_extension(self):
  o=self.due();self.dispatch(o)
  with self.assertRaises(HarnessError):self.wire('recover',request_id=self.req,recovery_id=o['attempt_id'])
  self.assertEqual(self.r.snapshot(self.thread['id'])['attempts'][0]['state'],'dispatching')
 def test_ack_wins_race_with_late_sent_receipt(self):
  o=self.due();self.dispatch(o);self.private('recover',request_id=self.req,recovery_id=o['attempt_id'])
  self.assertEqual(self.wire('finish',attempt_id=o['attempt_id'],result='sent')['state'],'acknowledged')
 def test_restart_keeps_budget_and_uncertain_dispatch(self):
  o=self.due();self.dispatch(o);self.h.recovery=Recovery(self.h);self.r=self.h.recovery;self.r.clock=lambda:self.now
  self.assertEqual(self.obs(failure='later')['reason'],'previous_dispatch_unknown_no_replay')
 def test_repairing_does_not_reset_per_request_budget(self):
  for i in range(3):
   o=self.due(str(i));self.dispatch(o);self.wire('finish',attempt_id=o['attempt_id'],result='sent')
  self.token=self.pair()['recovery_token'];self.assertEqual(self.obs(failure='four')['reason'],'recovery_budget_exhausted')
 def test_schema_extra_text_or_arbitrary_prompt_rejected(self):
  with self.assertRaises(HarnessError):self.obs(prompt='anything')
 def test_recovery_secrets_redacted(self):
  self.assertEqual(public(self.token),'[redacted]');self.assertEqual(public({'recovery_token':self.token}),{})
 def test_real_http_cors_does_not_open_ordinary_host_routes(self):
  server=create_server(0);server.harness_api=HarnessHTTP(self.s);t=threading.Thread(target=server.serve_forever,daemon=True);t.start();port=server.server_address[1]
  def http(path,body=None,method='POST'):
   c=HTTPConnection('127.0.0.1',port,timeout=5)
   headers={'Origin':ORIGIN,'Content-Type':'application/json','X-CLW-Recovery':self.token}
   if method=='OPTIONS':headers.update({'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-clw-recovery'})
   try:
    c.request(method,path,json.dumps(body).encode() if body is not None else None,headers);r=c.getresponse();return r.status,dict(r.getheaders()),r.read()
   finally:c.close()
  try:
   status,headers,_=http('/api/harness/recovery-wire',method='OPTIONS');self.assertEqual(status,204);self.assertEqual(headers['Access-Control-Allow-Origin'],ORIGIN)
   status,headers,body=http('/api/harness/recovery-wire',dict(action='status',chat_url=CHAT));self.assertEqual(status,200);self.assertNotIn(b'original',body)
   self.assertEqual(http('/api/harness/info',method='GET')[0],403)
   self.assertEqual(http('/api/harness/host-control',{})[0],403)
  finally:server.shutdown();server.server_close();t.join()
if __name__=='__main__':unittest.main(verbosity=2)
