"""Next-turn input preservation and original-event recovery; isolated, no model sends."""
from contextlib import closing
from pathlib import Path
import json,sys,unittest,uuid
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixtures
from test_harness_control_plane import PAGE
from harness_managed import ManagedPages
from harness_state import HarnessError,stamp
import harness_managed_recovery as recovery

class AttentionTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ManagedTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def team(self,page,op,p,key=None):
        return self.h.private(self.f.f.key,{'action':'team','store_id':self.h.state.id,'target_id':page,
            'session_id':self.f.sessions[page],'op':op,'operation_id':key or str(uuid.uuid4()),'payload':p})
    def finish(self,page,request,offer,claim,outcome,raw):
        self.f.private(page,'turn-end',{'request_id':request,'claim_id':claim,'outcome':outcome,'markdown':raw})
        return self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text=raw)
    def test_input_at_seal_keeps_current_delivery_and_one_durable_next_round(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        args={'request_id':request,'claim_id':ctx['request']['claim_id'],'outcome':'completed','markdown':'initial draft'}
        one=self.f.f.command(ctx['request']['thread_id'],'message.append',{'text':'Add the formula','expected_request_id':request})
        self.assertEqual(one['delivery_scope'],'next_round')
        saved=self.f.private(page,'turn-end',args,key='original-finalize')
        self.assertEqual(saved['state'],'turn_outcome_saved')
        self.assertEqual(saved['outcome'],'completed')
        self.assertFalse(saved['task_completed'])
        self.assertEqual(Path(saved['path']).read_text(encoding='utf-8'),'initial draft')
        two=self.f.f.command(ctx['request']['thread_id'],'message.append',{'text':'Keep the code','expected_request_id':request})
        self.assertEqual(self.f.private(page,'turn-end',args,key='original-finalize'),saved)
        queue=self.m.browser('next-round-read',{'page_id':page})
        self.assertEqual([x['id'] for x in queue['messages']],[one['operation_id'],two['operation_id']])
        self.assertEqual([x['text'] for x in queue['messages']],['Add the formula','Keep the code'])
        self.assertTrue(all(x['request_id']==request for x in queue['messages']))
        self.assertEqual(self.f.private(page,'context',{})['additional_instructions'],[])
        self.assertEqual(ManagedPages(self.h).browser('next-round-read',{'page_id':page}),queue)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_turn_outcomes WHERE attempt_id=?',(offer['attempt_id'],)).fetchone()[0],1)
        result=self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='initial draft')
        self.assertEqual(result['state'],'completed')
        batch=self.m.browser('next-round-prepare',{'page_id':page})['batch']
        self.assertEqual(batch['text'],'Add the formula\n\nKeep the code')
        self.assertEqual(self.m.browser('next-round-prepare',{'page_id':page})['batch'],batch)
        sent=self.f.f.command(ctx['request']['thread_id'],'message.send',{'text':batch['text']},key=batch['id'])
        self.assertEqual(self.f.f.command(ctx['request']['thread_id'],'message.send',{'text':batch['text']},key=batch['id']),sent)
        self.assertNotEqual(sent['request_id'],request)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE id=?',(offer['attempt_id']+'-tool',)).fetchone()[0],1)
            self.assertEqual(tuple(db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()),('completed',ctx['request']['claim_id']))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE id=?',(batch['id'],)).fetchone()[0],1)
    def test_attention_preserves_draft_even_with_unread_input(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        self.f.f.command(ctx['request']['thread_id'],'message.append',{'text':'new requirement','expected_request_id':request})
        self.assertEqual(self.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Saved draft; permission refused')['state'],'needs_attention')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE id=?',(offer['attempt_id']+'-tool',)).fetchone()[0],1)
        pending=self.m.browser('next-round-read',{'page_id':page})
        self.assertEqual([(x['request_id'],x['text']) for x in pending['messages']],[(request,'new requirement')])
    def test_closed_failed_turn_settles_once_without_replay_or_success(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        claim=ctx['request']['claim_id']
        self.team(page,'close',{'run_id':ctx['run']['id'],'claim_id':claim,
            'summary':'Independent work saved; one operation refused','references':[]})
        self.finish(page,request,offer,claim,'needs_attention','Original refusal and saved results')
        for _ in range(2):
            row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
            self.assertTrue(row['paused'])
            self.assertEqual(row['latest_request']['phase'],'blocked')
        with closing(self.h.state.connect()) as db:
            r=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(r['claim_id'],claim);self.assertIsNotNone(r['finished_at'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_closed_attention_reconciled'").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='host_turn_attention'").fetchone()[0],1)
        self.m.browser('pause',{'page_id':page,'paused':False})
        followup=self.f.f.command(ctx['request']['thread_id'],'message.send',{'text':'New independent remaining work'})
        self.assertNotEqual(followup['request_id'],request)
    def test_open_failed_run_remains_original_execution(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        self.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Investigate original job')
        self.m.browser('list',{})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
    def paused_controller(self,with_child=False):
        page,request,offer,ctx=self.f.start_browser_turn()
        if with_child:ctx['test_child']=self.f.enroll(page)[0]
        self.team(page,'pause',{'run_id':ctx['run']['id'],'reason':'Child execution needs reconciliation'})
        self.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Saved work; child remains queued')
        self.f.f.command(ctx['request']['thread_id'],'message.append',{'text':'Continue the complete original task','expected_request_id':request})
        return page,request,offer,ctx
    def test_operator_resume_unifies_run_and_page_preserving_original_work_once(self):
        page,request,offer,ctx=self.paused_controller(with_child=True)
        child=ctx['test_child']
        self.m.browser('pause',{'page_id':child,'paused':True})
        with closing(self.h.state.connect()) as db:
            before=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            artifacts=[dict(a) for a in db.execute('SELECT * FROM managed_artifacts WHERE request_id=?',(request,))]
        result=self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        self.assertEqual(result['resumed_original_requests'],[request])
        self.assertEqual(self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})['resumed_original_requests'],[])
        with closing(self.h.state.connect()) as db:
            after=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone())
            self.assertEqual(after['state'],'running');self.assertEqual(after['dispatches'],before['dispatches'])
            self.assertEqual(after['deadline'],before['deadline']);self.assertEqual(after['max_dispatches'],before['max_dispatches'])
            self.assertEqual(after['revision'],before['revision']+1)
            q=db.execute('SELECT * FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual(q['phase'],'suspended');self.assertEqual(q['claim_id'],ctx['request']['claim_id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual([dict(a) for a in db.execute('SELECT * FROM managed_artifacts WHERE request_id=?',(request,))],artifacts)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_operator_resumed_run'").fetchone()[0],1)
            self.assertTrue(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(child,)).fetchone()[0])
        queued=self.m.browser('next-round-read',{'page_id':page})
        self.assertEqual([(x['request_id'],x['text']) for x in queued['messages']],[(request,'Continue the complete original task')])
        next_turn=self.f.wire(page,'pulse')
        self.assertEqual(next_turn['state'],'offer')
        self.assertNotEqual(next_turn['attempt_id'],offer['attempt_id'])
        self.assertEqual(self.f.wire(page,'pulse')['attempt_id'],next_turn['attempt_id'])
    def test_resume_wrong_request_does_not_unpause_run_or_consume_note(self):
        page,request,offer,ctx=self.paused_controller()
        with self.assertRaisesRegex(HarnessError,'managed_resume_request_changed'):
            self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':'stale-request'})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()[0],'paused')
            self.assertTrue(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            self.assertIsNotNone(db.execute('SELECT * FROM managed_attention WHERE request_id=?',(request,)).fetchone())
    def test_actual_budget_failure_is_specific_and_resume_remains_atomic(self):
        for fault,sql in [('window_expired','deadline=0'),('sends_exhausted','dispatches=max_dispatches-1')]:
            with self.subTest(fault=fault):
                page,request,offer,ctx=self.paused_controller()
                with closing(self.h.state.connect()) as db:
                    db.execute('UPDATE host_runs SET '+sql+' WHERE id=?',(ctx['run']['id'],));db.commit()
                with self.assertRaisesRegex(HarnessError,'managed_resume_'+fault):
                    self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
                with closing(self.h.state.connect()) as db:
                    self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()[0],'paused')
                    self.assertTrue(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes WHERE request_id=?',(request,)).fetchone()[0],0)
                queued=self.m.browser('next-round-read',{'page_id':page})
                self.assertEqual([(x['request_id'],x['text']) for x in queued['messages']],[(request,'Continue the complete original task')])
    def test_maintenance_cannot_be_cleared_by_ordinary_resume(self):
        page,request,offer,ctx=self.paused_controller()
        with patch.object(self.h.team.maintenance,'held',return_value=True):
            with self.assertRaisesRegex(HarnessError,'team_use_resume_maintenance'):
                self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(ctx['run']['id'],)).fetchone()[0],'paused')
            self.assertTrue(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
    def test_pause_collects_original_turn_but_cannot_offer_or_send(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        self.m.browser('pause',{'page_id':page,'paused':True})
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        pending=self.m.browser('pending-receipt',{'page_id':page,'url':row['url']})
        self.assertEqual(pending['attempt_id'],offer['attempt_id'])
        self.assertFalse(pending['dispatch'])
        with self.assertRaises(HarnessError):self.f.wire(page,'pulse')
        with self.assertRaises(HarnessError):self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        raw='Original complete public manuscript; save tool was refused.'
        self.m.browser('artifact',{'page_id':page,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
        changed_picker={**PAGE,'model_label':'GPT-5.6','effort_label':'中','user_hash':'b'*64}
        for change in ({'user_hash':'e'*64},{'generating':True},{'draft':True}):
            with self.subTest(change=change), self.assertRaises(HarnessError):
                self.f.wire(page,'result',attempt_id=offer['attempt_id'],page={**changed_picker,**change},assistant_turn_hash='d'*64,text=raw)
        self.assertFalse(self.m.control.result_page_safe({}, {**changed_picker,'blocked':True}))
        result=self.f.wire(page,'result',attempt_id=offer['attempt_id'],page=changed_picker,assistant_turn_hash='d'*64,text=raw)
        self.assertEqual(result['state'],'needs_attention')
        self.assertEqual(self.m.browser('pending-receipt',{'page_id':page,'url':row['url']})['state'],'paused_no_pending_receipt')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertTrue(row['paused']);self.assertEqual(row['pause_origin']['source'],'operator')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
    def test_explicit_preclick_failure_releases_withdrawal_without_erasing_attempt(self):
        page,b=self.f.enroll()
        request=self.f.f.command(b['thread_id'],'message.send',{'text':'original unsent work'})['request_id']
        offer=self.f.wire(page,'pulse');self.f.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with self.assertRaises(HarnessError):self.m.browser('withdraw',{'page_id':page,'request_id':request})
        self.m.browser('pause',{'page_id':page,'paused':True})
        receipt=self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':'not_sent'}})
        self.assertEqual(receipt['state'],'not_sent')
        self.assertEqual(self.m.browser('withdraw',{'page_id':page,'request_id':request})['state'],'withdrawn')
        with closing(self.h.state.connect()) as db:
            attempt=db.execute('SELECT * FROM control_attempts WHERE id=?',(offer['attempt_id'],)).fetchone()
            self.assertEqual(attempt['state'],'not_sent');self.assertIsNotNone(attempt['dispatched'])
            self.assertIsNone(attempt['acknowledged'])
    def test_original_tool_wait_survives_remount_and_repairs_only_old_classification(self):
        page,request,offer,ctx=self.f.start_browser_turn()
        child,_=self.f.enroll(page)
        run=ctx['run']['id'];claim=ctx['request']['claim_id']
        self.team(page,'assign',{'run_id':run,'claim_id':claim,'target':child,'text':'independent work','depends_on':[],'resources':[]})
        self.team(page,'wait',{'run_id':run,'claim_id':claim,'after_seq':0,'mode':'all'})
        self.m.browser('pause',{'page_id':page,'paused':True})
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        remount={'page_id':page,'url':row['url'],'attempt_id':offer['attempt_id'],
                 'previous_user_hash':'b'*64,'user_hash':'f'*64,
                 'marker':f'[CLW:{offer["attempt_id"]}]','marker_count':1}
        # Reproduce the old, already persisted attention without inventing a wait.
        with patch.object(recovery,'original_wait_receipt',return_value=None):
            self.assertTrue(self.m.browser('reconcile-user',remount)['attention_only'])
            ended=self.f.wire(page,'result',attempt_id=offer['attempt_id'],
                page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'f'*64},
                assistant_turn_hash='d'*64,text='Original turn yielded after authenticated wait.')
            self.assertEqual(ended['state'],'needs_attention')
        with closing(self.h.state.connect()) as db:
            recovery.reconcile_wait_attention(self.m,db)
            recovery.reconcile_wait_attention(self.m,db)
            self.assertIsNone(db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_wait_receipt_reconciled'").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='host_turn_attention'").fetchone()[0],1)
            q=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual((q['phase'],q['claim_id']),('suspended',claim))
            self.assertTrue(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            db.commit()
        with self.assertRaises(HarnessError):self.f.wire(page,'pulse')
    def test_wait_all_collects_three_results_and_attention_once_without_retry(self):
        parent,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id'];claim=ctx['request']['claim_id']
        children=[]
        for _ in range(4):
            child,_=self.f.enroll(parent)
            assigned=self.team(parent,'assign',{'run_id':run,'claim_id':claim,'target':child,'text':'independent analysis','depends_on':[],'resources':[]})
            co=self.f.wire(child,'pulse');self.f.wire(child,'dispatch',attempt_id=co['attempt_id'])
            self.f.wire(child,'sent',attempt_id=co['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
            cc=self.f.private(child,'context',{});children.append((child,cc['request']['id'],co,cc['request']['claim_id']))
        self.assertEqual(self.team(parent,'wait',{'run_id':run,'claim_id':claim,'after_seq':0,'mode':'all'})['state'],'waiting_events')
        self.finish(parent,request,offer,claim,'yielded','Wait for the full group')
        for child,cr,co,cl in children[:3]:self.finish(child,cr,co,cl,'completed','Full result: \\[x^2\\]\n```py\npass\n```')
        # Real M owns project writing; its workers only read. A parked reader
        # must not keep a stale lease which prevents M from collecting results.
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_team_scopes SET access='write',write_paths='[\".\"]' WHERE thread_id=?",(ctx['request']['thread_id'],));db.commit()
        child,cr,co,cl=children[-1]
        self.finish(child,cr,co,cl,'needs_attention','Full saved draft; final routine tool check refused')
        self.m.browser('pause',{'page_id':parent,'paused':True})
        with self.assertRaises(HarnessError):self.f.wire(parent,'pulse')
        self.m.browser('pause',{'page_id':parent,'paused':False})
        result=self.team(parent,'result',{'run_id':run,'request_id':cr})
        self.assertEqual(result['phase'],'processing');self.assertIsNone(result['reply'])
        self.assertFalse(result['attention']['automatic_retry_authorized']);self.assertEqual(result['attention']['attempt_id'],co['attempt_id'])
        self.assertTrue(result['artifacts'])
        # Reconstruct the pre-fix case, with a genuine older event lacking
        # attempt_id and its missing derived signal. Recovery must index it once.
        with closing(self.h.state.connect()) as db:
            e=db.execute("SELECT seq,data FROM events WHERE kind='host_turn_attention' AND json_extract(data,'$.request_id')=?",(cr,)).fetchone()
            data=json.loads(e['data']);data.pop('attempt_id');db.execute('UPDATE events SET data=? WHERE seq=?',(json.dumps(data),e['seq']))
            # Older runtime kept both the reader reservation and active status.
            childthread=db.execute('SELECT thread_id FROM host_requests WHERE id=?',(cr,)).fetchone()[0]
            scope=db.execute('SELECT root FROM host_team_scopes WHERE thread_id=?',(childthread,)).fetchone()[0]
            db.execute("INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)",(cr,run,childthread,scope,'read','[]',self.h.clock()))
            db.execute("UPDATE threads SET status='processing' WHERE id=?",(childthread,))
            db.execute('DELETE FROM host_team_signals WHERE source_event=?',(e['seq'],));db.commit()
        ManagedPages(self.h);ManagedPages(self.h)
        with closing(self.h.state.connect()) as db:
            signals=[dict(x) for x in db.execute('SELECT * FROM host_team_signals WHERE run_id=?',(run,))]
            self.assertEqual(len(signals),4);self.assertEqual(sum(x['source_event']==e['seq'] for x in signals),1)
            r=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
            self.assertTrue(self.h.team.journal.wait_ready(db,r,'all',0))
            self.assertFalse(self.h.team.journal.wait_ready(db,r,'all',max(x['seq'] for x in signals)))
        wake=self.f.wire(parent,'pulse');self.assertEqual(wake['state'],'offer')
        self.assertEqual(self.f.wire(parent,'pulse')['attempt_id'],wake['attempt_id'])
        rows={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[child]['paused'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],claim)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(cr,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],2)
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(cr,)).fetchone())
    def test_attention_does_not_release_writer_or_exclusive_resource(self):
        for access,resources in [('write','[]'),('read','["unity"]')]:
            with self.subTest(access=access,resources=resources):
                page,request,offer,ctx=self.f.start_browser_turn()
                with closing(self.h.state.connect()) as db:
                    db.execute('UPDATE host_team_scopes SET access=?,resources=? WHERE thread_id=?',(access,resources,ctx['request']['thread_id']))
                    db.execute('UPDATE host_team_leases SET access=?,resources=? WHERE request_id=?',(access,resources,request));db.commit()
                self.finish(page,request,offer,ctx['request']['claim_id'],'needs_attention','Original job needs reconciliation')
                with closing(self.h.state.connect()) as db:
                    self.assertIsNotNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
                    # End isolated scenario so the next has no competing lease.
                    db.execute('DELETE FROM host_team_leases WHERE request_id=?',(request,))
                    db.execute("UPDATE threads SET status='needs_attention' WHERE id=?",(ctx['request']['thread_id'],));db.commit()

    def test_controller_retires_parked_branch_in_same_turn_without_success_fabrication(self):
        self.check_controller_retirement(False)
    def test_dom_fallback_remains_blocked_without_inventing_author_upload(self):
        self.check_controller_retirement(True)
    def test_settled_worker_accepts_new_work_without_replaying_old_request(self):
        self.check_controller_retirement(False,reuse=True)
    def test_explicit_operator_pause_survives_controller_retirement(self):
        self.check_controller_retirement(False,operator_pause=True)
    def test_unknown_legacy_pause_stays_paused(self):
        self.check_controller_retirement(False,legacy_pause=True)
    def check_controller_retirement(self,dom_only,reuse=False,operator_pause=False,legacy_pause=False):
        parent,request,offer,ctx=self.f.start_browser_turn();run=ctx['run']['id'];claim=ctx['request']['claim_id']
        child,_=self.f.enroll(parent)
        self.team(parent,'assign',{'run_id':run,'claim_id':claim,'target':child,'text':'Independent review','depends_on':[],'resources':[]})
        co=self.f.wire(child,'pulse');self.f.wire(child,'dispatch',attempt_id=co['attempt_id'])
        self.f.wire(child,'sent',attempt_id=co['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        cc=self.f.private(child,'context',{});cr=cc['request']['id'];cl=cc['request']['claim_id']
        if dom_only:
            self.m.browser('artifact',{'page_id':child,'attempt_id':co['attempt_id'],'text':'Public DOM; author upload refused'})
            self.f.wire(child,'result',attempt_id=co['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='Public DOM; author upload refused')
        else:self.finish(child,cr,co,cl,'needs_attention','Full draft; final check refused')
        p={'run_id':run,'claim_id':claim,'request_id':cr,'attempt_id':co['attempt_id'],'reason':'Read draft; retire failed branch, no retry'}
        with self.assertRaisesRegex(HarnessError,'team_read_attention_result_first'):self.team(parent,'settle-attention',p)
        self.team(parent,'result',{'run_id':run,'request_id':cr})
        note=self.f.f.command(cc['request']['thread_id'],'message.append',{'text':'unhandled operator request','expected_request_id':cr})
        self.assertEqual(note['delivery_scope'],'next_round')
        queued=self.m.browser('next-round-read',{'page_id':child})
        self.assertEqual([(x['request_id'],x['text']) for x in queued['messages']],[(cr,'unhandled operator request')])
        # A retained pre-queue current-turn note still requires an authenticated
        # context read. Newly queued input must remain independent of it.
        with closing(self.h.state.connect()) as db:
            legacy='legacy-'+uuid.uuid4().hex
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',(legacy,cr,'retained current-turn requirement',stamp()))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)',(legacy,cr));db.commit()
        with self.assertRaisesRegex(HarnessError,'team_attention_has_unread_instructions'):self.team(parent,'settle-attention',p)
        current=self.f.private(child,'context',{})
        self.assertEqual([x['text'] for x in current['additional_instructions']],['retained current-turn requirement'])
        self.assertEqual(self.m.browser('next-round-read',{'page_id':child}),queued)
        with self.assertRaisesRegex(HarnessError,'team_attention_not_current'):self.team(parent,'settle-attention',{**p,'attempt_id':'old-attempt'})
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='paused' WHERE id=?",(run,));db.commit()
        with self.assertRaisesRegex(HarnessError,'team_run_not_running'):self.team(parent,'settle-attention',p)
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_runs SET state='running' WHERE id=?",(run,));db.commit()
        if operator_pause:self.m.browser('pause',{'page_id':child,'paused':True})
        if legacy_pause:
            with closing(self.h.state.connect()) as db:
                db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(child,));db.commit()
        settled=self.team(parent,'settle-attention',p,key='settle-once-original')
        self.assertEqual(self.team(parent,'settle-attention',p,key='settle-once-original'),settled)
        self.assertEqual(settled['status'],'blocked');self.assertFalse(settled['worker_reported_success'])
        self.assertFalse(settled['model_called']);self.assertEqual(settled['author_markdown_saved'],not dom_only)
        self.assertEqual(settled['worker_available_for_new_work'],not (operator_pause or legacy_pause))
        self.assertFalse(settled['old_request_retried'])
        self.assertEqual(self.m.browser('next-round-read',{'page_id':child}),queued)
        result=self.team(parent,'result',{'run_id':run,'request_id':cr})
        self.assertIsNone(result['reply']);self.assertIsNone(result['attention']);self.assertEqual(result['resolution']['attempt_id'],co['attempt_id'])
        view=self.m.browser('view',{'page_id':child})
        self.assertIsNone(view['request']);self.assertEqual(view['latest_request']['phase'],'blocked')
        self.assertEqual(view['latest_request']['resolution']['author_markdown_saved'],not dom_only)
        listed=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==child)
        self.assertEqual(listed['latest_request'],view['latest_request'])
        self.assertEqual(listed['paused'],operator_pause or legacy_pause)
        if reuse:
            next_work=self.team(parent,'assign',{'run_id':run,'claim_id':claim,'target':child,'text':'Use the saved draft as context for this new independent review. Do not replay refused operations.','depends_on':[],'resources':[]})
            self.assertNotEqual(next_work['request_id'],cr)
            self.assertFalse(next_work['model_called'])
            with closing(self.h.state.connect()) as db:
                old=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(cr,)).fetchone()
                self.assertEqual(tuple(old),('blocked',cl))
                self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(cr,)).fetchone()[0],1)
            self.assertEqual(self.f.wire(child,'pulse')['request_id'],next_work['request_id'])
            return
        self.assertEqual(self.team(parent,'close',{'run_id':run,'claim_id':claim,'summary':'Retained blocked draft, no acceptance claim','references':[]})['state'],'closed')
        self.finish(parent,request,offer,claim,'completed','Current turn summary with failure recorded')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(cr,)).fetchone()[0],cl)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id IN (?,?)',(request,cr)).fetchone()[0],2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='assistant_message' AND json_extract(data,'$.request_id')=?",(cr,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE request_id=?',(cr,)).fetchone()[0],1)

if __name__=='__main__':unittest.main()
