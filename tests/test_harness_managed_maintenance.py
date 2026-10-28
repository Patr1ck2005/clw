"""Graceful maintenance preserves original requests and consumes no model turns."""
from contextlib import closing
import json,unittest,uuid,hashlib
import test_harness_managed_attention as attention_fixture
from test_harness_control_plane import PAGE
from harness_state import HarnessError
from harness_managed import ManagedPages

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.f=attention_fixture.AttentionTests();self.f.setUp();self.h=self.f.h;self.m=self.f.m;self.base=self.f.f
        self.now=10000.;self.h.clock=lambda:self.now
    def tearDown(self):self.f.tearDown()
    def team(self,*args,**kwargs):return self.f.team(*args,**kwargs)
    def child(self,parent,ctx,sent=True):
        child,_=self.base.enroll(parent)
        cr=self.team(parent,'assign',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],'target':child,'text':'Next whole work block','depends_on':[],'resources':[]})['request_id']
        co=self.base.wire(child,'pulse')
        if sent:
            self.base.wire(child,'dispatch',attempt_id=co['attempt_id'])
            self.base.wire(child,'sent',attempt_id=co['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_before_hash='c'*64)
            cc=self.base.private(child,'context',{})
        else:cc=None
        return child,cr,co,cc
    def settle_parent(self,parent,request,offer,ctx):
        self.team(parent,'wait',{'run_id':ctx['run']['id'],'claim_id':ctx['request']['claim_id'],'mode':'all','after_seq':0})
        self.base.wire(parent,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64},assistant_turn_hash='d'*64,text='Waiting for workers')
    def test_drains_existing_turns_preserves_queue_and_restarts_with_same_claim_and_results(self):
        parent,request,offer,ctx=self.base.start_browser_turn();run=ctx['run']['id']
        child,cr,co,cc=self.child(parent,ctx)
        queued,qr,qo,_=self.child(parent,ctx,False)
        self.settle_parent(parent,request,offer,ctx)
        one=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'quiesce-original'})
        self.assertEqual(one['state'],'holding');self.assertEqual(len(one['pending']),1)
        self.assertFalse(self.base.wire(queued,'dispatch',attempt_id=qo['attempt_id']).get('dispatch',False))
        self.f.finish(child,cr,co,cc['request']['claim_id'],'completed','Original full \\(x^2\\) and code')
        self.h.team.tick()
        view=self.m.browser('view',{'page_id':parent});status=view['maintenance']
        self.assertEqual(status['state'],'settled');self.assertEqual(view['run']['state'],'paused')
        self.assertEqual(view['request']['phase'],'suspended');self.assertFalse(self.base.wire(parent,'pulse').get('dispatch',False))
        # Restart only the transport projection, reading the same durable ledger.
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        self.assertEqual(self.m.browser('view',{'page_id':parent})['maintenance']['checkpoint_hash'],status['checkpoint_hash'])
        with closing(self.h.state.connect()) as db:
            before=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
            checkpoint=json.loads(db.execute('SELECT checkpoint FROM host_team_maintenance WHERE run_id=?',(run,)).fetchone()[0])
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(qr,)).fetchone()[0],'queued')
            self.assertEqual(checkpoint['requests'][0]['cancel_requested'],0)
            self.assertTrue(checkpoint['artifacts'])
        self.now+=900
        from pathlib import Path
        saved_file=Path(checkpoint['artifacts'][0]['path']);original=saved_file.read_bytes();saved_file.write_bytes(b'changed after checkpoint')
        with self.assertRaisesRegex(HarnessError,'artifact_changed'):
            self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','checkpoint_hash':status['checkpoint_hash'],'operation_id':'reject-changed-artifact'})
        saved_file.write_bytes(original)
        with self.assertRaisesRegex(HarnessError,'checkpoint_changed'):
            self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','checkpoint_hash':'wrong','operation_id':'wrong-resume-checkpoint'})
        resumed=self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','checkpoint_hash':status['checkpoint_hash'],'operation_id':'resume-original-maintenance'})
        self.assertEqual(resumed['state'],'resumed')
        with closing(self.h.state.connect()) as db:
            after=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run,)).fetchone())
            self.assertEqual(after['dispatches'],before['dispatches']);self.assertEqual(after['deadline'],before['deadline']+900)
            self.assertEqual(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0],ctx['request']['claim_id'])
        self.assertIsNone(self.m.browser('view',{'page_id':parent})['maintenance'])
    def test_unknown_send_cannot_be_certified_quiet_or_replayed(self):
        parent,request,offer,ctx=self.base.start_browser_turn()
        child,cr,co,_=self.child(parent,ctx,False)
        self.base.wire(child,'dispatch',attempt_id=co['attempt_id'])
        self.settle_parent(parent,request,offer,ctx)
        status=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'unknown-send-hold'})
        self.assertEqual(status['state'],'holding');self.assertEqual(status['pending'][0]['delivery'],'dispatching')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase,cancel_requested FROM host_requests WHERE id=?',(cr,)).fetchone()['cancel_requested'],0)
        self.h.team.tick();self.assertEqual(self.m.browser('view',{'page_id':parent})['maintenance']['state'],'holding')
    def test_new_enrollment_is_held_without_changing_manual_pause_intent(self):
        parent,request,offer,ctx=self.base.start_browser_turn()
        child,_=self.base.reserve(parent)
        self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'hold-new-enrollment'})
        with self.assertRaisesRegex(HarnessError,'maintenance_no_new_dispatch'):self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        listed=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==child)
        self.assertTrue(listed['paused']);self.assertFalse(listed['own_paused']);self.assertEqual(listed['bootstrap_state'],'pending')

    def test_unfinished_hold_can_be_withdrawn_without_resolving_unknown_enrollment_or_send(self):
        parent,request,offer,ctx=self.base.start_browser_turn()
        child,cr,co,_=self.child(parent,ctx,False)
        self.base.wire(child,'dispatch',attempt_id=co['attempt_id'])
        pending,_=self.base.reserve(parent)
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE managed_pages SET bootstrap_state='unknown',paused=1 WHERE page_id=?",(pending,))
            db.execute("INSERT INTO managed_page_issues VALUES(?,'bootstrap_receipt_missing','Original indeterminate operation')",(pending,))
            db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'operator',NULL)",(pending,));db.commit()
        self.settle_parent(parent,request,offer,ctx)
        held=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'withdraw-pending-hold'})
        self.assertEqual(held['state'],'holding')
        self.assertIn('enrollment',{p['kind'] for p in held['pending']})
        tables=('host_runs','host_requests','control_attempts','control_browser_receipts','host_team_leases',
                'managed_pages','managed_page_issues','managed_pause_owners')
        def snapshot():
            with closing(self.h.state.connect()) as db:
                return {t:[tuple(r) for r in db.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in tables}
        before=snapshot()
        resumed=self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance',
          'expected_run_id':ctx['run']['id'],'expected_revision':held['revision'],'operation_id':'withdraw-only-original-intent'})
        self.assertEqual(resumed['state'],'resumed');self.assertTrue(resumed['pending_maintenance_withdrawn'])
        self.assertFalse(resumed['external_jobs_verified']);self.assertFalse(resumed['model_called'])
        self.assertEqual(snapshot(),before)
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        self.assertIsNone(self.m.browser('view',{'page_id':parent})['maintenance'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(co['attempt_id'],)).fetchone()[0],'dispatching')
            row=db.execute('SELECT phase,paused,bootstrap_state FROM managed_pages WHERE page_id=?',(pending,)).fetchone()
            self.assertEqual(tuple(row),('reserved',1,'unknown'))

    def test_unfinished_hold_requires_the_original_run_and_revision(self):
        parent,request,offer,ctx=self.base.start_browser_turn()
        held=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'guarded-original-hold'})
        self.assertEqual(held['state'],'holding')
        base={'page_id':parent,'action':'resume-maintenance','expected_run_id':ctx['run']['id']}
        for revision in (None,True,held['revision']+1):
            with self.subTest(revision=revision),self.assertRaisesRegex(HarnessError,'maintenance_intent_changed'):
                self.m.browser('maintenance',{**base,'expected_revision':revision,'operation_id':str(uuid.uuid4())})
        with self.assertRaisesRegex(HarnessError,'maintenance_run_changed'):
            self.m.browser('maintenance',{**base,'expected_run_id':'wrong-run','expected_revision':held['revision'],'operation_id':'wrong-original-run'})
        self.m.browser('maintenance',{**base,'expected_revision':held['revision'],'operation_id':'withdraw-first-hold'})
        next_hold=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'next-original-hold'})
        self.assertGreater(next_hold['revision'],held['revision'])
        with self.assertRaisesRegex(HarnessError,'maintenance_intent_changed'):
            self.m.browser('maintenance',{**base,'expected_revision':held['revision'],'operation_id':'stale-first-hold'})
        self.assertEqual(self.m.browser('view',{'page_id':parent})['maintenance']['state'],'holding')

    def test_withdrawal_racing_a_saved_checkpoint_still_requires_that_checkpoint(self):
        parent,request,offer,ctx=self.base.start_browser_turn()
        held=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'checkpoint-race-hold'})
        self.settle_parent(parent,request,offer,ctx);self.h.team.tick()
        settled=self.m.browser('view',{'page_id':parent})['maintenance']
        self.assertEqual(settled['state'],'settled')
        with self.assertRaisesRegex(HarnessError,'maintenance_checkpoint_changed'):
            self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','expected_run_id':ctx['run']['id'],
              'expected_revision':held['revision'],'operation_id':'stale-unfinished-resume'})
        self.assertEqual(self.m.browser('view',{'page_id':parent})['maintenance']['checkpoint_hash'],settled['checkpoint_hash'])

    def test_saved_writer_attention_can_be_maintained_only_after_fresh_operator_job_audit(self):
        parent,request,offer,ctx=self.base.start_browser_turn();run=ctx['run']['id'];thread=ctx['request']['thread_id']
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_team_scopes SET access='write',write_paths='[\".\"]' WHERE thread_id=?",(thread,))
            db.execute("UPDATE host_team_leases SET access='write' WHERE request_id=?",(request,));db.commit()
        self.f.finish(parent,request,offer,ctx['request']['claim_id'],'needs_attention','Original result; refused action not retried')
        held=self.m.browser('maintenance',{'page_id':parent,'action':'quiesce','operation_id':'held-writer-maintenance'})
        self.assertEqual(held['state'],'holding');self.assertEqual(held['pending'][0]['kind'],'execution_lease')
        evidence=self.h.root/'evidence'/'idle.json';evidence.parent.mkdir(exist_ok=True)
        def proof(running=0,age=0):
            evidence.write_text(json.dumps({'source':'Local-MCP-B.runtime_status','observed_at':self.now-age,
              'result':{'structuredContent':{'success':True,'error':None,'output':{'focus':{'connected':True,'client_id':'fixture'},
              'jobs':{'active_count':running,'running_count':running,'queued_count':0}}}}}),encoding='utf8')
            return {'run_id':run,'request_id':request,'attempt_id':offer['attempt_id'],'evidence_path':str(evidence),
              'evidence_sha256':hashlib.sha256(evidence.read_bytes()).hexdigest()}
        payload=proof()
        with self.assertRaisesRegex(HarnessError,'operator_audit_required'):self.team(parent,'verify-maintenance-idle',payload)
        for values in ({'running':1},{'age':301}):
            with self.assertRaisesRegex(HarnessError,'external_execution_not_idle'):
                self.h.team.public_command(thread,str(uuid.uuid4()),'verify-maintenance-idle',{**proof(**values),'confirm':True})
        verified=self.h.team.public_command(thread,'verified-original-writer-idle','verify-maintenance-idle',{**proof(),'confirm':True})
        self.assertEqual(verified['state'],'settled')
        self.m.browser('maintenance',{'page_id':parent,'action':'resume-maintenance','checkpoint_hash':verified['checkpoint_hash'],'operation_id':'resume-maintained-writer'})
        with closing(self.h.state.connect()) as db:
            self.assertTrue(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(request,)).fetchone())
            self.assertTrue(db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',(request,)).fetchone())
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(parent,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)

if __name__=='__main__':unittest.main()
