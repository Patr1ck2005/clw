"""Carrier lifetime against real isolated Host receipts; no browser/model sends."""
from pathlib import Path
from contextlib import closing
import json,sys,unittest
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed_attention as fixtures
import test_harness_managed_first_task as first_fixtures
from harness_renderer_lifecycle import project_lifecycle


class RendererLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.AttentionTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def finished_attention(self):
        page,request,offer,ctx=self.f.f.start_browser_turn()
        self.f.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Original result and refusal saved')
        return page,request,offer,ctx
    def read(self,page):
        with closing(self.h.state.connect()) as db:
            db.execute('PRAGMA query_only=ON')
            row=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page,)).fetchone()
            return project_lifecycle(db,row)
    def test_saved_attention_stays_processing_but_needs_no_renderer(self):
        page,request,offer,_=self.finished_attention();before=self.h.state.path.read_bytes()
        for _ in range(20):
            result=self.read(page);self.assertFalse(result['required']);self.assertEqual(result['reason'],'carrier_reply_saved')
            self.assertEqual(result['attempt_id'],offer['attempt_id'])
        self.assertEqual(self.h.state.path.read_bytes(),before)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
        self.assertEqual(self.m.browser('view',{'page_id':page})['renderer_lifecycle'],result)
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['renderer_lifecycle'],result)
    def test_saved_old_reply_cannot_settle_a_later_accepted_attempt(self):
        page,request,offer,_=self.finished_attention()
        with closing(self.h.state.connect()) as db:
            old=db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()
            columns=list(old.keys());values=[old[k] for k in columns]
            values[columns.index('id')]='control_later_original';values[columns.index('offered')]=old['offered']+1
            values[columns.index('epoch')]='later-original-epoch'
            db.execute('INSERT INTO control_attempts('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',values)
            db.commit()
        self.assertTrue(self.read(page)['required']);self.assertEqual(self.read(page)['reason'],'original_result_pending')
    def test_current_source_claim_must_still_match_saved_carrier_claim(self):
        page,request,_,_=self.finished_attention()
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_requests SET claim_id='new-current-claim' WHERE id=?",(request,));db.commit()
        self.assertTrue(self.read(page)['required']);self.assertEqual(self.read(page)['reason'],'original_receipt_unverified')
    def test_missing_or_mismatched_original_host_reply_keeps_renderer(self):
        page,request,offer,_=self.finished_attention()
        with closing(self.h.state.connect()) as db:
            reply=db.execute('SELECT reply_id FROM control_browser_receipts WHERE attempt_id=?',(offer['attempt_id'],)).fetchone()[0]
            response=json.loads(db.execute('SELECT response FROM host_replies WHERE id=?',(reply,)).fetchone()[0])
            db.execute('UPDATE host_replies SET response=? WHERE id=?',(json.dumps({**response,'thread_id':'another-thread'}),reply));db.commit()
        self.assertTrue(self.read(page)['required'])
        with closing(self.h.state.connect()) as db:db.execute("UPDATE host_replies SET response='not-json' WHERE id=?",(reply,));db.commit()
        self.assertTrue(self.read(page)['required'])
        with closing(self.h.state.connect()) as db:db.execute('DELETE FROM host_replies WHERE id=?',(reply,));db.commit()
        self.assertTrue(self.read(page)['required'])
    def test_execution_lease_unknown_operation_and_current_thread_execution_override_old_reply(self):
        page,request,_,ctx=self.finished_attention();thread=ctx['request']['thread_id']
        with closing(self.h.state.connect()) as db:
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)',(request,ctx['run']['id'],thread,str(self.h.root),'read','[]',1));db.commit()
        self.assertEqual(self.read(page)['reason'],'execution_lease')
        with closing(self.h.state.connect()) as db:
            db.execute('DELETE FROM host_team_leases WHERE request_id=?',(request,))
            db.execute("UPDATE operations SET state='unknown' WHERE thread_id=?",(thread,));db.commit()
        self.assertEqual(self.read(page)['reason'],'original_operation_pending')
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE operations SET state='completed' WHERE thread_id=?",(thread,))
            db.execute("UPDATE threads SET status='working',active_turn=? WHERE id=?",(request,thread));db.commit()
        self.assertEqual(self.read(page)['reason'],'current_thread_execution')
    def test_dispatching_sent_unknown_attempts_are_not_saved_history(self):
        page,_,offer,_=self.finished_attention()
        for state in ('dispatching','sent','unknown'):
            with self.subTest(state=state),closing(self.h.state.connect()) as db:
                db.execute('UPDATE control_attempts SET state=? WHERE id=?',(state,offer['attempt_id']));db.commit()
                self.assertEqual(self.read(page)['reason'],'original_attempt_pending')
    def test_unbound_unknown_preserves_identity_and_requires_only_its_original_page(self):
        page,_=self.f.f.reserve()
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE managed_pages SET bootstrap_state='unknown',paused=1 WHERE page_id=?",(page,));db.commit()
        self.assertEqual(self.read(page)['reason'],'bootstrap_original_page_only')
        self.assertTrue(self.read(page)['required'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT bootstrap_state FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0],'unknown')
    def test_old_terminal_companion_ack_without_browser_receipt_is_history_while_active_ack_still_pins(self):
        page,request,offer,ctx=self.finished_attention()
        with closing(self.h.state.connect()) as db:
            db.execute("INSERT INTO host_requests VALUES(?,?,?,'completed',?,0,'2000-01-01', '2000-01-02')",
                       ('old-companion-request',ctx['request']['thread_id'],'Original old companion work','old-companion-claim'))
            old=db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()
            columns=list(old.keys());values=[old[k] for k in columns]
            values[columns.index('id')]='control_old_companion';values[columns.index('request_id')]='old-companion-request';values[columns.index('epoch')]=0
            db.execute('INSERT INTO control_attempts('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',values);db.commit()
            self.assertFalse(self.read(page)['required'])
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',('control_old_companion',)).fetchone()[0],'acknowledged')
            db.execute("UPDATE host_requests SET phase='processing',finished_at=NULL WHERE id='old-companion-request'");db.commit()
            self.assertEqual(self.read(page)['reason'],'original_result_pending')
    def test_real_yielded_carrier_can_wait_for_children_without_a_resident_browser(self):
        page,request,offer,ctx=self.f.f.start_browser_turn();child,_=self.f.f.enroll(page)
        self.f.team(page,'assign',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],'target':child,'text':'Independent original child','depends_on':[],'resources':[]})
        self.f.team(page,'wait',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],'after_seq':0,'mode':'all'})
        self.f.finish(page,request,offer,ctx['request']['claim_id'],'yielded','Waiting for the original child')
        result=self.read(page);self.assertFalse(result['required']);self.assertEqual(result['outcome'],'yielded')
        with closing(self.h.state.connect()) as db:
            q=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(q['phase'],'suspended');self.assertEqual(q['claim_id'],ctx['request']['claim_id'])
    def test_real_not_sent_original_attempt_is_unsent_without_erasing_it(self):
        page,b=self.f.f.enroll();queued=self.f.f.f.command(b['thread_id'],'message.send',{'text':'Original future work'})
        offer=self.f.f.wire(page,'pulse');self.f.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':'not_sent'}})
        self.m.browser('pause',{'page_id':page,'paused':True})
        result=self.read(page);self.assertFalse(result['required']);self.assertEqual(result['reason'],'original_attempt_not_sent')
        self.assertEqual(result['request_id'],queued['request_id']);self.assertEqual(result['attempt_id'],offer['attempt_id'])


class FirstCarrierLifecycleTests(unittest.TestCase):
    def setUp(self):self.f=first_fixtures.FirstTaskTests();self.f.setUp()
    def tearDown(self):self.f.tearDown()
    def test_real_first_carrier_yield_needs_exact_public_reconciliation_and_later_attempt_still_pins(self):
        parent,enrollment=self.f.receive(access='write',write_paths=['.'])
        started=self.f.f.private(parent,'first-task',{})
        child,_=self.f.receive(parent,historical_busy_send=True)
        self.f.f.private(parent,'wait-ready',{'targets':[child]})
        self.f.finish(parent,started['request'],'Original first carrier yielded','yielded')
        with closing(self.f.f.h.state.connect()) as db:
            row=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(parent,)).fetchone()
            self.assertTrue(project_lifecycle(db,row)['required'])
        self.f.m.browser('bind-first-turn',self.f.public_turn(parent))
        with closing(self.f.f.h.state.connect()) as db:
            row=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(parent,)).fetchone()
            result=project_lifecycle(db,row);self.assertFalse(result['required']);self.assertEqual(result['reason'],'first_carrier_yield_saved')
            db.execute("UPDATE host_requests SET claim_id='new-first-current-claim' WHERE id=?",(started['request']['id'],))
            self.assertTrue(project_lifecycle(db,row)['required'])
            db.execute('UPDATE host_requests SET claim_id=? WHERE id=?',(started['request']['claim_id'],started['request']['id']))
            db.execute("INSERT INTO control_attempts VALUES(?,?,?,?,?,'unknown',?,1,1,NULL)",
                       ('control_later_first',started['request']['id'],started['request']['thread_id'],'later-epoch',1,'f'*64));db.commit()
            self.assertTrue(project_lifecycle(db,row)['required'])

if __name__=='__main__':unittest.main()
