"""Autonomous run regressions use isolated actors, never real ChatGPT acceptance."""
from pathlib import Path
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import copy,json,sys,tempfile,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_collaboration as fixtures
from test_harness_control_plane import PAGE,ORIGIN,URL
from harness_state import HarnessError

class TeamTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.CollaborationTests();self.f.setUp();self.h=self.f.s.host_bridge
        self.now=1000.;self.h.clock=lambda:self.now;self.n=0;self.pages={}
    def tearDown(self):self.f.tearDown()
    def call(self,op,payload=None,target='main',key=None):
        self.n+=1
        return self.f.p(target,'team',op=op,operation_id=key or ('team-test-operation-%06d'%self.n),payload=payload or {})
    def enroll(self,target='main'):
        ticket=self.call('invite',{'target':target,'allow_rebind':False,'ttl_seconds':600,'reason':'isolated fixture enrollment'})
        receipt=self.call('enroll',{'ticket':ticket['ticket'],'project':self.h.targets['main']['project'],'root':str(self.f.root)},target)
        url=URL if target=='main' else URL.replace('11111111','22222222' if target=='child-a' else '33333333')
        boot=self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url,tab_nonce=uuid.uuid5(uuid.NAMESPACE_DNS,target).hex,page=PAGE,confirm_low_cost=True,enrollment=receipt['browser_marker']))
        self.assertEqual(len(boot['candidates']),1)
        paired=self.h.control.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],confirm=True,confirm_low_cost=True,chat_url=url,tab_nonce=uuid.uuid5(uuid.NAMESPACE_DNS,target).hex,page=PAGE))
        self.h.control.wire(ORIGIN,paired['control_token'],dict(action='pulse',generation=paired['generation'],chat_url=url,tab_nonce=uuid.uuid5(uuid.NAMESPACE_DNS,target).hex,page=PAGE))
        self.pages[target]=(paired,url)
        return paired,url
    def workspace(self,target='main',read_only=False,root=None,resources=None):
        return self.call('workspace',{'target':target,'project':self.h.targets['main']['project'],
            'root':str(root or self.f.root),'access':'read' if read_only else 'write','write_paths':[] if read_only else ['evidence'],
            'resources':resources or [],'confirm':True})
    def start_run(self,seconds=100,max_dispatches=8,read_only=False,max_parallel=4,root=None):
        self.enroll();self.workspace(read_only=read_only,root=root);r=self.f.start()
        run=self.call('open',{'request_id':r,'claim_id':self.f.claim,'duration_seconds':seconds,
            'max_dispatches':max_dispatches,'max_parallel':max_parallel,'goal_ref':'operator-test-goal','constraints':'No outside projects or models'})
        return r,run
    def assign(self,run,target='child-a',depends=None,key=None):
        return self.call('assign',{'run_id':run['run_id'],'claim_id':self.f.claim,'target':target,
            'text':'A substantial complete work block','depends_on':depends or [],'resources':[]},key=key)
    def wait(self,run,after=0,mode='all'):
        return self.call('wait',{'run_id':run['run_id'],'claim_id':self.f.claim,'after_seq':after,'mode':mode})
    def test_join_does_not_certify_a_physical_browser(self):
        self.f.join();rows=self.f.p('main','branches')['children']
        self.assertEqual(rows[0]['carrier']['state'],'logical_only')
        self.assertFalse(rows[0]['carrier']['runnable'])
    def test_default_run_has_no_worker_count_limit(self):
        self.enroll();self.workspace();request=self.f.start()
        run=self.call('open',{'request_id':request,'claim_id':self.f.claim,'goal_ref':'operator-goal','constraints':'Keep resource exclusion.'})
        with closing(self.h.state.connect()) as db:run=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run['run_id'],)).fetchone())
        self.assertEqual(run['max_parallel'],0)
        self.assertIsNone(run['max_dispatches'])
        self.assertIsNone(run['deadline'])

    def test_explicit_concurrency_is_not_capped_at_sixteen(self):
        _,run=self.start_run(max_parallel=1000)
        with closing(self.h.state.connect()) as db:run=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run['run_id'],)).fetchone())
        self.assertEqual(run['max_parallel'],1000)
    def test_invitation_is_readonly_to_business_requests_and_idempotent(self):
        self.f.join();key='team-invitation-original-key'
        body={'target':'child-a','allow_rebind':False,'ttl_seconds':600,'reason':'fixture'}
        one=self.call('invite',body,key=key);two=self.call('invite',body,key=key)
        self.assertEqual(one,two)
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
    def test_enrollment_needs_its_exact_ticket_session_and_project(self):
        self.f.join();p=self.call('invite',{'target':'child-a','allow_rebind':False,'ttl_seconds':600,'reason':'fixture'})
        with self.assertRaises(HarnessError):self.call('enroll',{'ticket':p['ticket'],'project':'wrong','root':str(self.f.root)},'child-a')
        with self.assertRaises(HarnessError):self.call('enroll',{'ticket':p['ticket'],'project':self.h.targets['main']['project'],'root':str(self.f.root)},'main')
    def test_enrollment_expiry_never_creates_work(self):
        self.f.join();p=self.call('invite',{'target':'child-a','allow_rebind':False,'ttl_seconds':30,'reason':'fixture'});self.now+=31
        with self.assertRaises(HarnessError):self.call('enroll',{'ticket':p['ticket'],'project':self.h.targets['main']['project'],'root':str(self.f.root)},'child-a')
    def test_enroll_and_browser_binding_are_both_required(self):
        self.f.join();self.enroll('child-a');c=self.call('status')['carriers']
        row=next(x for x in c if x['target_id']=='child-a')
        self.assertEqual(row['state'],'receiver_confirmed');self.assertTrue(row['runnable'])
        self.now+=301
        self.assertFalse(next(x for x in self.call('status')['carriers'] if x['target_id']=='child-a')['runnable'])
    def test_no_run_without_verified_controller(self):
        self.workspace();r=self.f.start()
        with self.assertRaises(HarnessError):self.call('open',{'request_id':r,'claim_id':self.f.claim,'duration_seconds':100,'max_dispatches':8,'max_parallel':2,'goal_ref':'g','constraints':'c'})
    def test_assignment_uses_original_host_request_graph(self):
        self.f.join();self.enroll('child-a');self.workspace('child-a');r,run=self.start_run()
        d=self.assign(run);self.assertEqual(self.f.p('child-a','read',request_id=d['request_id'])['delegation']['parent_request_id'],r)
        self.wait(run);self.assertEqual(self.f.p('child-a','read',request_id=d['request_id'])['phase'],'queued')
    def test_assignment_replay_same_key_does_not_duplicate_work(self):
        self.f.join();self.enroll('child-a');self.workspace('child-a');r,run=self.start_run()
        one=self.assign(run,key='team-stable-assignment-key');self.assertEqual(one,self.assign(run,key='team-stable-assignment-key'))
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_delegations WHERE parent_request_id=?',(r,)).fetchone()[0],1)
    def test_missing_carrier_is_not_a_waiting_fake_worker(self):
        self.f.join();self.workspace('child-a');r,run=self.start_run()
        with self.assertRaises(HarnessError):self.assign(run)
    def test_checkpoint_compare_and_swap(self):
        r,run=self.start_run();p={'run_id':run['run_id'],'expected_version':0,'summary':'Completed algebra, missing full wave','references':[],'basis_seq':0}
        snap=self.call('checkpoint',p);self.assertEqual(snap['version'],1)
        with self.assertRaises(HarnessError):self.call('checkpoint',p)
    def test_deadline_drains_without_starting_models_or_resetting_claim(self):
        r,run=self.start_run(seconds=10);self.now+=11;self.h.team.tick()
        state=self.call('context',{'run_id':run['run_id'],'after_seq':0})
        self.assertEqual(state['run']['state'],'draining');self.assertEqual(self.f.p('main','read',request_id=r)['phase'],'processing')
        self.assertEqual(state['run']['dispatches'],0)
    def test_pause_and_resume_preserve_original_deadline(self):
        r,run=self.start_run();one=self.call('pause',{'run_id':run['run_id'],'reason':'operator pause'})
        self.assertEqual(one['state'],'paused')
        v=self.call('context',{'run_id':run['run_id'],'after_seq':0})['run'];deadline=v['deadline']
        self.now+=20;res=self.call('resume',{'run_id':run['run_id'],'expected_revision':v['revision'],'confirm':True})
        self.assertEqual(res['deadline'],deadline)
    def test_expired_run_cannot_resume_without_new_authorization(self):
        r,run=self.start_run(seconds=5);self.now+=6;self.h.team.tick();v=self.call('context',{'run_id':run['run_id'],'after_seq':0})['run']
        with self.assertRaises(HarnessError):self.call('resume',{'run_id':run['run_id'],'expected_revision':v['revision'],'confirm':True})
    def test_dependency_cannot_reference_arbitrary_or_other_run_work(self):
        self.f.join();self.enroll('child-a');self.workspace('child-a');r,run=self.start_run()
        with self.assertRaises(HarnessError):self.assign(run,depends=['not-from-this-run'])
    def test_path_traversal_write_grant_rejected(self):
        with self.assertRaises(HarnessError):self.call('workspace',{'target':'main','project':self.h.targets['main']['project'],'root':str(self.f.root),'access':'write','write_paths':['../escape'],'resources':[],'confirm':True})
    def test_readonly_grant_cannot_claim_write_paths(self):
        with self.assertRaises(HarnessError):self.call('workspace',{'target':'main','project':self.h.targets['main']['project'],'root':str(self.f.root),'access':'read','write_paths':['evidence'],'resources':[],'confirm':True})
    def test_no_native_provider_is_launched(self):
        self.start_run();self.assertIsNone(self.f.s.connection);self.assertEqual(self.f.bridge.posts,[])

    def wire(self,target,action,**data):
        pair,url=self.pages[target]
        return self.h.control.wire(ORIGIN,pair['control_token'],dict(action=action,generation=pair['generation'],chat_url=url,
            tab_nonce=uuid.uuid5(uuid.NAMESPACE_DNS,target).hex,**data))
    def send_receive(self,target):
        offer=self.wire(target,'pulse',page=PAGE);self.assertEqual(offer['state'],'offer',offer)
        grant=self.wire(target,'dispatch',attempt_id=offer['attempt_id'],page=PAGE);self.assertTrue(grant['dispatch'],grant)
        got=self.f.p(target,'control-receive',attempt_id=offer['attempt_id'])
        return offer,got
    def final(self,target,got,text='Complete isolated worker result'):
        return self.f.finish(target,got['request_id'],got['original_claim_id'],text=text)
    def parallel_setup(self,shared=False,slots=4,budget=8):
        dirs={}
        for t in ['main','child-a','child-b']:
            p=self.f.root/('shared' if shared else t);p.mkdir(exist_ok=True);dirs[t]=p
        for t in ['child-a','child-b']:
            self.f.join(t);self.enroll(t);self.workspace(t,root=dirs[t])
        r,run=self.start_run(max_dispatches=budget,max_parallel=slots,root=dirs['main'])
        a=self.assign(run);b=self.assign(run,'child-b');self.wait(run,mode='any')
        return r,run,a,b
    def test_disjoint_scopes_support_concurrent_original_claims(self):
        r,run,a,b=self.parallel_setup();oa,ga=self.send_receive('child-a');ob,gb=self.send_receive('child-b')
        self.assertEqual(self.f.p('child-a','read',request_id=a['request_id'])['phase'],'processing')
        self.assertEqual(self.f.p('child-b','read',request_id=b['request_id'])['phase'],'processing')
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases').fetchone()[0],2)
    def test_same_scope_conflicts_even_before_first_receiver_claims(self):
        r,run,a,b=self.parallel_setup(shared=True)
        o=self.wire('child-a','pulse',page=PAGE);self.wire('child-a','dispatch',attempt_id=o['attempt_id'],page=PAGE)
        self.assertNotEqual(self.wire('child-b','pulse',page=PAGE)['state'],'offer')
        with self.assertRaises(HarnessError):self.f.p('child-b','claim',request_id=b['request_id'],claim_id=str(uuid.uuid4()))
    def test_conflicting_queue_preserves_order_even_if_later_worker_polls_first(self):
        r,run,a,b=self.parallel_setup(shared=True)
        late=self.wire('child-b','pulse',page=PAGE)
        if late['state']=='offer':self.assertFalse(self.wire('child-b','dispatch',attempt_id=late['attempt_id'],page=PAGE)['dispatch'])
        first,accepted=self.send_receive('child-a')
        self.assertEqual(accepted['request_id'],a['request_id'])
    def test_ready_controller_continuation_precedes_conflicting_new_worker(self):
        r,run,a,b=self.parallel_setup(shared=True)
        offer,worker=self.send_receive('child-a');self.final('child-a',worker)
        later=self.wire('child-b','pulse',page=PAGE)
        if later['state']=='offer':self.assertFalse(self.wire('child-b','dispatch',attempt_id=later['attempt_id'],page=PAGE)['dispatch'])
        resumed,controller=self.send_receive('main')
        self.assertEqual(controller['request_id'],r)
    def test_invalid_queued_workspace_does_not_block_another_project_resource_user(self):
        roots={}
        for target in ('main','child-a','child-b'):
            roots[target]=self.f.root/target;roots[target].mkdir()
        for target in ('child-a','child-b'):
            self.f.join(target);self.enroll(target)
            self.workspace(target,root=roots[target],resources=['shared-unity-editor'])
        request,run=self.start_run(root=roots['main'])
        first=self.assign(run);second=self.assign(run,'child-b');self.wait(run)
        # Only remove an empty, test-owned directory. A stale admission cannot
        # own the resource or starve a valid queued workspace indefinitely.
        roots['child-a'].rmdir()
        offer,accepted=self.send_receive('child-b')
        self.assertEqual(accepted['request_id'],second['request_id'])
        with closing(self.h.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(first['request_id'],)).fetchone())
    def test_parallel_slot_is_durably_reserved_before_send(self):
        r,run,a,b=self.parallel_setup(slots=1)
        first=self.wire('child-a','pulse',page=PAGE);second=self.wire('child-b','pulse',page=PAGE)
        self.assertTrue(self.wire('child-a','dispatch',attempt_id=first['attempt_id'],page=PAGE)['dispatch'])
        blocked=self.wire('child-b','dispatch',attempt_id=second['attempt_id'],page=PAGE);self.assertFalse(blocked['dispatch']);self.assertEqual(blocked['state'],'team_waiting_admission')
        state=self.call('context',{'run_id':run['run_id'],'after_seq':0})['run'];self.assertEqual(state['dispatches'],1)
    def test_any_result_wakes_original_M_while_other_disjoint_worker_runs(self):
        r,run,a,b=self.parallel_setup();oa,ga=self.send_receive('child-a');ob,gb=self.send_receive('child-b')
        self.final('child-a',ga);om,gm=self.send_receive('main')
        self.assertEqual(gm['request_id'],r);self.assertEqual(gm['original_claim_id'],self.f.claim)
        self.assertEqual(self.f.p('child-b','read',request_id=b['request_id'])['phase'],'processing')
        with self.assertRaises(HarnessError):self.f.finish('main',r,self.f.claim)
    def test_all_wait_keeps_M_asleep_until_every_original_result(self):
        r,run,a,b=self.parallel_setup()
        # Change a wait policy only while the real original controller is active.
        with closing(self.h.state.connect()) as db:db.execute("UPDATE host_runs SET wait_mode='all' WHERE id=?",(run['run_id'],));db.commit()
        oa,ga=self.send_receive('child-a');ob,gb=self.send_receive('child-b');self.final('child-a',ga)
        self.assertNotEqual(self.wire('main','pulse',page=PAGE)['state'],'offer')
        self.final('child-b',gb);om,gm=self.send_receive('main');self.assertEqual(gm['original_claim_id'],self.f.claim)
    def test_full_reply_read_required_before_signal_ack_and_final(self):
        self.f.join();self.enroll('child-a');self.workspace('child-a');r,run=self.start_run();self.assign(run);self.wait(run)
        o,g=self.send_receive('child-a');body='Actual full fixture result. '*1200;self.final('child-a',g,body)
        om,gm=self.send_receive('main');ctx=self.call('context',{'run_id':run['run_id'],'after_seq':0});seq=ctx['next_after']
        with self.assertRaises(HarnessError):self.wait(run,after=seq)
        with self.assertRaises(HarnessError):self.f.finish('main',r,self.f.claim)
        result=self.call('result',{'run_id':run['run_id'],'request_id':g['request_id']});self.assertEqual(result['reply']['text'],body)
        self.f.finish('main',r,self.f.claim)
        self.assertEqual(self.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['state'],'closed')
    def test_deadline_granted_worker_can_ack_and_finish_then_final_summary_once(self):
        self.f.join();self.enroll('child-a');self.workspace('child-a');r,run=self.start_run(seconds=10)
        self.assign(run);self.wait(run);o=self.wire('child-a','pulse',page=PAGE);self.wire('child-a','dispatch',attempt_id=o['attempt_id'],page=PAGE)
        self.now+=11;self.h.team.tick();g=self.f.p('child-a','control-receive',attempt_id=o['attempt_id']);self.final('child-a',g)
        om,gm=self.send_receive('main');self.assertEqual(gm['original_claim_id'],self.f.claim)
        current=self.call('context',{'run_id':run['run_id'],'after_seq':0})['run'];self.assertEqual(current['state'],'draining');self.assertEqual(current['dispatches'],2);self.assertEqual(current['final_granted'],1)
        with self.assertRaises(HarnessError):self.assign(run)
        again=self.f.p('main','control-receive',attempt_id=om['attempt_id']);self.assertTrue(again['already_received'])
        self.assertEqual(self.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['dispatches'],2)
    def test_budget_includes_final_summary_and_does_not_send_cancelled_work(self):
        r,run,a,b=self.parallel_setup(budget=2)
        oa,ga=self.send_receive('child-a');other=self.wire('child-b','pulse',page=PAGE)
        self.assertEqual(other['state'],'offer')
        denied=self.wire('child-b','dispatch',attempt_id=other['attempt_id'],page=PAGE);self.assertFalse(denied['dispatch'])
        self.assertEqual(self.f.p('child-b','read',request_id=b['request_id'])['phase'],'cancelled')
        self.final('child-a',ga);om,gm=self.send_receive('main')
        self.assertEqual(self.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['dispatches'],2)
    def test_unknown_send_retains_lease_across_restart_without_resend(self):
        r,run,a,b=self.parallel_setup(shared=True)
        o=self.wire('child-a','pulse',page=PAGE);self.wire('child-a','dispatch',attempt_id=o['attempt_id'],page=PAGE)
        self.wire('child-a','finish',attempt_id=o['attempt_id'],result='unknown');sid=self.h.state.id
        self.f.s.close();self.f.s=fixtures.HarnessService(self.f.root,self.f.root/'state',connection_factory=fixtures.FakeConnection,web_targets=copy.deepcopy(fixtures.CONFIG),web_bridge=self.f.bridge)
        self.h=self.f.s.host_bridge;self.h.clock=lambda:self.now
        self.assertEqual(self.h.state.id,sid)
        self.assertNotEqual(self.wire('child-b','pulse',page=PAGE)['state'],'offer')
        with self.assertRaises(HarnessError):self.wire('child-a','dispatch',attempt_id=o['attempt_id'],page=PAGE)
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases').fetchone()[0],1)
    def test_controller_scope_cannot_change_while_waiting(self):
        r,run=self.start_run();self.wait(run)
        with self.assertRaises(HarnessError):self.workspace(read_only=True)
    def test_old_delegate_cannot_bypass_managed_run_admission(self):
        self.f.join();r,run=self.start_run()
        with self.assertRaises(HarnessError):self.f.delegate(r)
        with self.assertRaises(HarnessError):self.f.yield_parent(r)
    def test_controller_verified_runtime_session_recovers_orphan_and_ticket_binds_same_page(self):
        self.f.join();r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r)
        invite=self.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'Operator verified a new real receiver Session'})
        old=self.f.sessions['child-a'];new='wc_sess_wwwwwwwwwwwwwwww'
        proof=self.call('recover-enroll',{'invitation_id':invite['invitation_id'],'receiver_session':new,
            'runtime_project':self.h.targets['main']['project'],'runtime_event_id':'evt_'+'a'*32,
            'confirm':True,'reason':'Runtime session ledger shows the receiver opened this exact enrollment'})
        self.assertEqual(proof['session_id'],new);self.assertTrue(proof['browser_ticket_required']);self.assertFalse(proof['browser_marker_required'])
        self.f.sessions['child-a']=new
        url=URL.replace('11111111','88888888');nonce='f'*32
        boot=self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=url,tab_nonce=nonce,page=PAGE,
            confirm_low_cost=True,enrollment_ticket=invite['ticket']))
        self.assertEqual(boot['state'],'one_confirmed_receiver');self.assertEqual(len(boot['candidates']),1)
        paired=self.h.control.wire(ORIGIN,None,dict(action='bind',discovery_id=boot['candidates'][0]['discovery_id'],
            confirm=True,confirm_low_cost=True,chat_url=url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(paired['adopted_request_id'],d['child_request_id'])
        pulse=self.h.control.wire(ORIGIN,paired['control_token'],dict(action='pulse',generation=paired['generation'],
            chat_url=url,tab_nonce=nonce,page=PAGE))
        self.assertEqual(pulse['request_id'],d['child_request_id'])
        self.assertEqual(self.f.p('child-a','read',request_id=d['child_request_id'])['phase'],'queued')
        with closing(self.h.state.connect()) as db:
            spec=json.loads(db.execute("SELECT spec FROM host_bindings WHERE target_id='child-a'").fetchone()[0])
            self.assertEqual(spec['session_id'],new)
            history=db.execute('SELECT previous_session,session_id FROM host_carrier_history ORDER BY seq DESC LIMIT 1').fetchone()
            self.assertEqual((history[0],history[1]),(old,new))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_delegations WHERE parent_request_id=?',(r,)).fetchone()[0],1)

    def test_controller_verified_runtime_revalidation_can_rearm_one_stale_orphan_ticket(self):
        self.f.join();r=self.f.start();self.f.delegate(r);self.f.yield_parent(r)
        invite=self.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':30,'reason':'fixture'})
        self.now+=31
        proof=self.call('recover-enroll',{'invitation_id':invite['invitation_id'],'receiver_session':'wc_sess_yyyyyyyyyyyyyyyy',
            'runtime_project':self.h.targets['main']['project'],'runtime_event_id':'evt_'+'c'*32,
            'confirm':True,'reason':'Fresh Runtime ledger proves this same receiver after the ticket TTL elapsed'})
        self.assertTrue(proof['browser_ticket_required'])
        with closing(self.h.state.connect()) as db:
            row=db.execute('SELECT state,expires FROM host_carrier_invites WHERE id=?',(invite['invitation_id'],)).fetchone()
            self.assertEqual(row['state'],'accepted');self.assertGreaterEqual(row['expires'],self.now+3599)

    def test_controller_verified_recovery_rejects_claimed_or_physical_branch(self):
        self.f.join();r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r)
        invite=self.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'fixture'})
        self.f.p('child-a','claim',request_id=d['child_request_id'],claim_id=fixtures.uid())
        with self.assertRaises(HarnessError):self.call('recover-enroll',{'invitation_id':invite['invitation_id'],
            'receiver_session':'wc_sess_xxxxxxxxxxxxxxxx','runtime_project':self.h.targets['main']['project'],
            'runtime_event_id':'evt_'+'b'*32,'confirm':True,'reason':'must not steal a claim'})
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT state FROM host_carrier_invites WHERE id=?',(invite['invitation_id'],)).fetchone()[0],'pending')

    def test_new_receiver_can_explicitly_recover_orphan_but_not_steal_claim(self):
        self.f.join();r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r)
        invite=self.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'User confirms no old physical chat exists'})
        old=self.f.sessions['child-a'];self.f.sessions['child-a']='wc_sess_uuuuuuuuuuuuuuuu'
        proof=self.call('enroll',{'ticket':invite['ticket'],'project':self.h.targets['main']['project'],'root':str(self.f.root)},'child-a')
        self.assertTrue(proof['original_requests_preserved'])
        self.assertEqual(self.f.p('child-a','read',request_id=d['child_request_id'])['phase'],'queued')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT previous_session FROM host_carrier_history ORDER BY seq DESC LIMIT 1').fetchone()[0],old)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_delegations WHERE parent_request_id=?',(r,)).fetchone()[0],1)

if __name__=='__main__':unittest.main(verbosity=2)
