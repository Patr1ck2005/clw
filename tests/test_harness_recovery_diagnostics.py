"""Metadata-only observation: no actual browser or provider attestation."""
from pathlib import Path
from contextlib import closing
import copy, json, sys, unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_recovery as fixtures
from harness_recovery import Recovery
from harness_state import HarnessError
PAGE={'adapter_version':'0.1.1','kind':'idle','visible':True,'controls_known':True,'assistant_identity_known':True,'user_identity_known':True,'terminal_marker':False,'draft':False,'composing':False,'generating':False}
class DiagnosticsTests(unittest.TestCase):
 setUp=fixtures.RecoveryTests.setUp;tearDown=fixtures.RecoveryTests.tearDown
 private=fixtures.RecoveryTests.private;cmd=fixtures.RecoveryTests.cmd;pair=fixtures.RecoveryTests.pair;wire=fixtures.RecoveryTests.wire
 def test_legacy_status_supported_without_inventing_dom_support(self):
  self.assertTrue(self.wire('status')['page_diagnostics_supported'])
  v=self.r.snapshot(self.thread['id']);self.assertTrue(v['paired']);self.assertIsNone(v['page_observation']);self.assertFalse(v['actual_page_adapter_verified'])
 def test_observe_page_does_not_start_a_retry(self):
  self.wire('status',page=PAGE);v=self.r.snapshot(self.thread['id'])
  self.assertEqual(v['page_observation']['adapter_version'],'0.1.1');self.assertTrue(v['page_observation']['recent']);self.assertEqual(v['attempts'],[])
 def test_observation_supported_while_no_task_is_active(self):
  claim='clw-diagnostics-original-claim';self.private('claim',request_id=self.req,claim_id=claim)
  self.private('reply',request_id=self.req,claim_id=claim,reply_id='clw-diagnostics-final-reply',status='completed',text='fixture')
  self.assertIsNone(self.wire('status',page=PAGE)['request_id']);self.assertTrue(self.r.snapshot(self.thread['id'])['observer_recent'])
 def test_no_error_simulation_from_diagnostic_kind(self):
  self.wire('status',page={**PAGE,'kind':'cannot_think','terminal_marker':True})
  self.assertEqual(self.r.snapshot(self.thread['id'])['attempts'],[])
 def test_unknown_payload_or_type_rejected(self):
  for extra in [{'chat_text':'private'},{'visible':1},{'kind':'unbounded_text'},{'adapter_version':'https://other.invalid'}, {'editor_html':'private'}]:
   with self.subTest(extra=extra),self.assertRaises(HarnessError):self.wire('status',page={**PAGE,**extra})
  self.assertIsNone(self.r.snapshot(self.thread['id'])['page_observation'])
 def test_same_peer_updates_one_row_and_cannot_publish_secrets(self):
  for i in range(4):self.now+=1;self.wire('status',page=PAGE)
  with closing(self.s.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM recovery_observations').fetchone()[0],1)
  text=json.dumps(self.r.snapshot(self.thread['id']));self.assertNotIn(self.token,text);self.assertNotIn(self.key,text)
 def test_pairing_expiry_not_recent_or_current(self):
  self.wire('status',page=PAGE)
  with closing(self.s.state.connect()) as db:db.execute('UPDATE recovery_peers SET expires=?',(self.now-1,));db.commit()
  v=self.r.snapshot(self.thread['id']);self.assertFalse(v['paired']);self.assertFalse(v['observer_recent']);self.assertIsNone(v['page_observation'])
 def test_stale_diagnostics_and_disable_are_not_reported_live(self):
  self.wire('status',page=PAGE);self.now+=21
  v=self.r.snapshot(self.thread['id']);self.assertFalse(v['observer_recent']);self.assertFalse(v['page_observation']['recent'])
  self.r.disable(self.thread['id']);self.assertIsNone(self.r.snapshot(self.thread['id'])['page_observation'])
 def test_restart_preserves_original_peer_without_creating_attempts(self):
  self.wire('status',page=PAGE);self.r=Recovery(self.h);self.r.clock=lambda:self.now
  self.assertTrue(self.r.snapshot(self.thread['id'])['paired']);self.assertEqual(self.r.snapshot(self.thread['id'])['attempts'],[])
if __name__=='__main__':unittest.main(verbosity=2)
