"""Real SQLite/Host protocol recovery, without a browser or external model."""
from pathlib import Path
from contextlib import closing
import sys,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from harness_state import HarnessError
from harness_managed_unsent_retry import KIND

class KnownUnsentRetryTests(unittest.TestCase):
    setUp=fixture.ManagedTests.setUp
    tearDown=fixture.ManagedTests.tearDown
    reserve=fixture.ManagedTests.reserve
    private=fixture.ManagedTests.private
    enroll=fixture.ManagedTests.enroll
    wire=fixture.ManagedTests.wire
    def prepared(self,result='not_sent'):
        page,binding=self.enroll()
        request=self.f.command(binding['thread_id'],'message.send',{'text':'Complete original bounded package'})['request_id']
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        if result!='dispatching':
            self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':result}})
        self.m.browser('page-issue',{'page_id':page,'kind':'control_failed','detail':'Original pre-Send failure'})
        return page,request,offer['attempt_id']
    def events(self,request):
        with closing(self.h.state.connect()) as db:
            return db.execute("SELECT seq,data FROM events WHERE kind=? AND json_extract(data,'$.request_id')=? ORDER BY seq",(KIND,request)).fetchall()
    def attempt(self,attempt):
        with closing(self.h.state.connect()) as db:
            return dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(attempt,)).fetchone())
    def resume(self,page,request):
        return self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
    def test_explicit_resume_retries_same_request_once_and_preserves_failed_attempt(self):
        page,request,old=self.prepared();original=self.attempt(old)
        self.m.browser('pause',{'page_id':page,'paused':False})
        self.assertEqual(self.wire(page,'pulse')['state'],'original_attempt_requires_reconciliation')
        self.assertEqual(self.events(request),[])
        self.assertEqual(self.resume(page,request)['known_unsent_original_attempt'],old)
        self.assertEqual(self.resume(page,request)['known_unsent_original_attempt'],old)
        self.assertEqual(len(self.events(request)),1)
        offer=self.wire(page,'pulse')
        self.assertEqual(offer['state'],'offer');self.assertEqual(offer['request_id'],request)
        self.assertNotEqual(offer['attempt_id'],old)
        self.assertEqual(self.wire(page,'pulse')['attempt_id'],offer['attempt_id'])
        self.assertEqual(self.attempt(old),original)
        # A reload only reads the durable authorization; it cannot invent one.
        self.m.control=type(self.m.control)(self.m)
        self.assertEqual(self.wire(page,'pulse')['attempt_id'],offer['attempt_id'])
        self.assertTrue(self.wire(page,'dispatch',attempt_id=offer['attempt_id'])['dispatch'])
        self.assertIsNone(self.resume(page,request)['known_unsent_original_attempt'])
        self.assertEqual(len(self.events(request)),1)
        self.assertEqual(self.wire(page,'pulse')['attempt_id'],offer['attempt_id'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual([row[0] for row in db.execute('SELECT id FROM host_requests WHERE thread_id=(SELECT thread_id FROM managed_pages WHERE page_id=?)',(page,))],[request])
            self.assertIsNone(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0])
    def test_unknown_sent_and_dispatching_remain_original_reconciliation(self):
        for state in ('unknown','sent','dispatching'):
            with self.subTest(state=state):
                page,request,old=self.prepared(state);original=self.attempt(old)
                self.assertIsNone(self.resume(page,request)['known_unsent_original_attempt'])
                self.assertEqual(self.events(request),[])
                observed=self.wire(page,'pulse')
                self.assertEqual(observed['state'],'original_attempt_requires_reconciliation')
                self.assertEqual(observed['attempt_id'],old);self.assertEqual(self.attempt(old),original)
    def test_stale_owner_rejected_without_authorization_or_attempt_changes(self):
        page,request,old=self.prepared();original=self.attempt(old)
        with self.assertRaises(HarnessError):self.resume(page,'another-request')
        self.assertEqual(self.events(request),[]);self.assertEqual(self.attempt(old),original)
    def test_second_confirmed_unsent_needs_a_second_explicit_resume(self):
        page,request,old=self.prepared();self.resume(page,request)
        second=self.wire(page,'pulse')['attempt_id'];self.wire(page,'dispatch',attempt_id=second)
        self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':second,'result':'not_sent'}})
        self.assertEqual(self.wire(page,'pulse')['attempt_id'],second)
        self.assertEqual(len(self.events(request)),1)
        self.resume(page,request);third=self.wire(page,'pulse')['attempt_id']
        self.assertNotIn(third,(old,second));self.assertEqual(len(self.events(request)),2)
        self.assertEqual(self.attempt(old)['state'],'not_sent');self.assertEqual(self.attempt(second)['state'],'not_sent')
    def test_old_unsent_proof_cannot_authorize_a_later_waiting_epoch(self):
        page,request,old=self.prepared();original=self.attempt(old)
        with closing(self.h.state.connect()) as db:
            thread=db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0]
            self.h.emit(db,thread,'host_waiting_children',{'request_id':request,'reason':'new original wait epoch'})
            db.commit()
        self.assertIsNone(self.resume(page,request)['known_unsent_original_attempt'])
        self.assertEqual(self.events(request),[]);self.assertEqual(self.attempt(old),original)

if __name__=='__main__':unittest.main()
