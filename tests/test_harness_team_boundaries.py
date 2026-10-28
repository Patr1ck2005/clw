"""Persistence, scope, concurrency and source-provenance boundaries; isolated only."""
from pathlib import Path
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import copy,json,subprocess,sys,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_team as base
from test_harness_control_plane import PAGE,URL,ORIGIN,receiver_marker
from harness_state import HarnessError
from harness_workspace_probe import inspect_git
from harness_team_client import parse_payload

class BoundaryTests(unittest.TestCase):
    def setUp(self):self.b=base.TeamTests();self.b.setUp();self.h=self.b.h
    def tearDown(self):self.b.tearDown()
    def test_import_is_exact_public_source_not_automatic_task_or_truth(self):
        p={'name':'Public controller export','source':{'kind':'controller_public_export','reference':'M supplied note','captured_at':'2026-09-24'},
           'objective':'Check the stated conjecture, not an invented objective','constraints':['Frozen statement remains unchanged'],
           'decisions':['Claim X is unresolved, not proved'], 'participants':[{'label':'V','responsibility':'independent verification','progress':'not started','references':[]}],'references':['project/current.md']}
        r=self.b.call('import-context',p,key='fixed-context-import');self.assertEqual(r,self.b.call('import-context',p,key='fixed-context-import'))
        read=self.b.call('intake',{'intake_id':r['intake_id']});self.assertEqual(read['payload'],p);self.assertFalse(read['claims_verified'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_bindings').fetchone()[0],1)
    def test_import_rejects_fake_hidden_context_or_foreign_owner(self):
        p={'name':'x','source':{'kind':'hidden_chain_of_thought','reference':'x','captured_at':'x'},'objective':'x','constraints':[],'decisions':[],'participants':[],'references':[]}
        with self.assertRaises(HarnessError):self.b.call('import-context',p)
        p['source']['kind']='user_copy';r=self.b.call('import-context',p);self.b.f.join()
        with self.assertRaises(HarnessError):self.b.call('intake',{'intake_id':r['intake_id']},target='child-a')
    def test_cli_rejects_duplicate_keys_nonfinite_and_nonobjects(self):
        for raw in ['{"a":1,"a":2}','{"n":NaN}','[]','null']:
            with self.assertRaises(ValueError):parse_payload(raw)
        self.assertEqual(parse_payload('{"a":"原文"}'),{'a':'原文'})
    def test_parallel_slot_race_grants_only_one_and_wait_is_not_failure(self):
        r,run,a,b=self.b.parallel_setup(slots=1)
        offers={t:self.b.wire(t,'pulse',page=PAGE) for t in ('child-a','child-b')}
        def dispatch(t):return t,self.b.wire(t,'dispatch',attempt_id=offers[t]['attempt_id'],page=PAGE)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(dispatch,offers))
        self.assertEqual(sum(bool(v.get('dispatch')) for _,v in results),1)
        winner=next(t for t,v in results if v.get('dispatch'));loser=next(t for t,v in results if not v.get('dispatch'))
        g=self.b.f.p(winner,'control-receive',attempt_id=offers[winner]['attempt_id']);self.b.final(winner,g)
        grant=self.b.wire(loser,'dispatch',attempt_id=offers[loser]['attempt_id'],page=PAGE);self.assertTrue(grant['dispatch'])
    def test_shared_resource_serializes_distinct_roots(self):
        dirs={}
        for t in ('main','child-a','child-b'):
            dirs[t]=self.b.f.root/t;dirs[t].mkdir()
        for t in ('child-a','child-b'):
            self.b.f.join(t);self.b.enroll(t);self.b.workspace(t,root=dirs[t],resources=['approved-engine-slot'])
        r,run=self.b.start_run(root=dirs['main']);self.b.assign(run);self.b.assign(run,'child-b');self.b.wait(run)
        self.b.send_receive('child-a');self.assertNotEqual(self.b.wire('child-b','pulse',page=PAGE)['state'],'offer')
    def test_legacy_unknown_owner_blocks_new_team_sends(self):
        r,run,a,b=self.b.parallel_setup()
        legacy=self.h.state.bind('legacy-fixture','unknown old execution',self.b.f.root)
        self.h.state.update(legacy['id'],status='unknown')
        self.assertNotEqual(self.b.wire('child-a','pulse',page=PAGE)['state'],'offer')
    def test_signal_arriving_while_M_is_active_stays_in_same_model_turn(self):
        r,run,a,b=self.b.parallel_setup();_,ga=self.b.send_receive('child-a');_,gb=self.b.send_receive('child-b')
        self.b.final('child-a',ga);_,gm=self.b.send_receive('main');self.b.final('child-b',gb)
        before=self.b.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['dispatches']
        result=self.b.wait(run,after=0,mode='any');self.assertEqual(result['state'],'events_ready_continue_same_turn')
        self.assertEqual(self.b.f.p('main','read',request_id=r)['phase'],'processing')
        self.assertEqual(self.b.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['dispatches'],before)
    def test_pause_after_grant_returns_current_pause_state_to_original_receiver(self):
        r,run,a,b=self.b.parallel_setup();o=self.b.wire('child-a','pulse',page=PAGE)
        self.b.wire('child-a','dispatch',attempt_id=o['attempt_id'],page=PAGE)
        self.b.call('pause',{'run_id':run['run_id'],'reason':'operator pause'})
        got=self.b.f.p('child-a','control-receive',attempt_id=o['attempt_id']);self.assertEqual(got['run_state']['state'],'paused')
        self.assertNotEqual(self.b.wire('child-b','pulse',page=PAGE)['state'],'offer')
    def test_deadline_and_budgets_survive_database_reopen(self):
        r,run,a,b=self.b.parallel_setup();_,ga=self.b.send_receive('child-a')
        original=self.b.call('context',{'run_id':run['run_id'],'after_seq':0})['run']
        self.b.f.s.close();self.b.f.s=base.fixtures.HarnessService(self.b.f.root,self.b.f.root/'state',connection_factory=base.fixtures.FakeConnection,web_targets=copy.deepcopy(base.fixtures.CONFIG),web_bridge=self.b.f.bridge)
        self.b.h=self.b.f.s.host_bridge;self.h=self.b.h;self.h.clock=lambda:self.b.now
        after=self.b.call('context',{'run_id':run['run_id'],'after_seq':0})['run']
        self.assertEqual(after['deadline'],original['deadline']);self.assertEqual(after['dispatches'],1)
        self.b.now=after['deadline']+1;self.h.team.tick()
        self.assertEqual(self.b.call('context',{'run_id':run['run_id'],'after_seq':0})['run']['state'],'draining')
    def test_enrollment_revocation_blocks_marker_without_cancelling_task(self):
        self.b.f.join();invite=self.b.call('invite',{'target':'child-a','allow_rebind':False,'ttl_seconds':600,'reason':'fixture'})
        got=self.b.call('enroll',{'ticket':invite['ticket'],'project':self.h.targets['main']['project'],'root':str(self.b.f.root)},target='child-a')
        self.b.call('revoke',{'invitation_id':invite['invitation_id'],'reason':'operator revoked'})
        with self.assertRaises(HarnessError):self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL,tab_nonce='a'*32,page=PAGE,confirm_low_cost=True,enrollment=got['browser_marker']))
    def test_enrollment_marker_cannot_override_known_other_page(self):
        self.b.f.join();self.b.enroll('main');marker=receiver_marker(self.b.f)
        with self.assertRaises(HarnessError):self.h.control.wire(ORIGIN,None,dict(action='bootstrap',chat_url=URL,tab_nonce='e'*32,page=PAGE,confirm_low_cost=True,enrollment=marker))
    def test_claimed_orphan_never_changes_owner(self):
        self.b.f.join();r=self.b.f.start();d=self.b.f.delegate(r);self.b.f.yield_parent(r)
        self.b.f.p('child-a','claim',request_id=d['child_request_id'],claim_id=base.fixtures.uid())
        invite=self.b.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'wrong proposal'})
        old=self.b.f.sessions['child-a'];self.b.f.sessions['child-a']='wc_sess_vvvvvvvvvvvvvvvv'
        with self.assertRaises(HarnessError):self.b.call('enroll',{'ticket':invite['ticket'],'project':self.h.targets['main']['project'],'root':str(self.b.f.root)},target='child-a')
        with closing(self.h.state.connect()) as db:self.assertEqual(json.loads(db.execute("SELECT spec FROM host_bindings WHERE target_id='child-a'").fetchone()[0])['session_id'],old)
    def test_snapshot_context_is_compact_full_original_is_read_on_demand(self):
        r,run=self.b.start_run();summary='明确未证明的命题；'*1000
        self.b.call('checkpoint',{'run_id':run['run_id'],'expected_version':0,'summary':summary,'references':['original-proof.md'],'basis_seq':0})
        ctx=self.b.call('context',{'run_id':run['run_id'],'after_seq':0});self.assertLess(len(ctx['snapshots'][0]['summary_excerpt']),300)
        snap=self.b.call('snapshot',{'run_id':run['run_id'],'target':'main','version':1});self.assertEqual(snap['summary'],summary)
    def test_native_git_worktree_identity_and_frozen_head_checked(self):
        root=self.b.f.root/'repo';root.mkdir();other=self.b.f.root/'worker-tree'
        def git(cwd,*args):
            p=subprocess.run(['git','-C',str(cwd),*args],capture_output=True,text=True,encoding='utf-8',timeout=20)
            self.assertEqual(p.returncode,0,p.stderr);return p.stdout.strip()
        git(root,'init');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','isolated fixture')
        head=git(root,'rev-parse','HEAD');git(root,'worktree','add','-b','fixture-worker',str(other),head)
        a=inspect_git(root);b=inspect_git(other);self.assertEqual(a['head'],b['head']);self.assertEqual(a['common_dir'],b['common_dir']);self.assertNotEqual(a['root'],b['root'])
        self.b.call('workspace',{'target':'main','project':self.h.targets['main']['project'],'root':str(other),'access':'write','write_paths':['evidence'],'resources':[],'expected_git_head':head,'confirm':True})
        git(other,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','isolated later head')
        with closing(self.h.state.connect()) as db:scope=self.h.team.scopes.scope(db,self.b.f.parent['id'])
        with self.assertRaises(HarnessError):self.h.team.scopes.verify(scope)
    def test_long_slot_wait_does_not_expire_an_uncommitted_managed_offer(self):
        r,run,a,b=self.b.parallel_setup(slots=1)
        with closing(self.h.state.connect()) as db:db.execute('UPDATE host_runs SET deadline=? WHERE id=?',(self.b.now+3600,run['run_id']));db.commit()
        offers={t:self.b.wire(t,'pulse',page=PAGE) for t in ('child-a','child-b')}
        self.b.wire('child-a','dispatch',attempt_id=offers['child-a']['attempt_id'],page=PAGE)
        blocked=self.b.wire('child-b','dispatch',attempt_id=offers['child-b']['attempt_id'],page=PAGE);self.assertFalse(blocked['dispatch'])
        ga=self.b.f.p('child-a','control-receive',attempt_id=offers['child-a']['attempt_id'])
        self.b.now+=180;self.b.final('child-a',ga)
        renewed=self.b.wire('child-b','pulse',page=PAGE);self.assertEqual(renewed['attempt_id'],offers['child-b']['attempt_id'])
        self.assertTrue(self.b.wire('child-b','dispatch',attempt_id=renewed['attempt_id'],page=PAGE)['dispatch'])
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(b['request_id'],)).fetchone()[0],1)
    def test_two_registered_disjoint_controllers_can_queue_while_other_is_working(self):
        main=self.b.f.root/'main-scope';main.mkdir();child=self.b.f.root/'other-scope';child.mkdir()
        self.b.f.join();self.b.enroll('child-a');self.b.workspace('child-a',root=child)
        r,run=self.b.start_run(root=main)
        thread=self.b.f.s.state.by_native('mcp-host/'+self.b.f.sessions['child-a'])['id']
        second=self.b.f.command(thread,'message.send',{'text':'Independent other project controller request'})
        self.assertEqual(self.b.f.p('child-a','read',request_id=second['request_id'])['phase'],'queued')
        self.assertEqual(self.b.f.p('main','read',request_id=r)['phase'],'processing')
    def test_ui_receipt_recovers_committed_invitation_not_duplicate(self):
        raw={'request_id':base.fixtures.uid(),'action':'team.invite','thread_id':self.b.f.parent['id'],
            'data':{'confirm':True,'title':'new fixture receiver','allow_rebind':False,'ttl_seconds':600,'reason':'test'}}
        original=self.b.f.s.state.operation
        def crash(*a,**k):raise OSError('simulated UI reply lost')
        self.b.f.s.state.operation=crash
        try:
            try:self.b.f.s.command(raw)
            except OSError:pass
        finally:self.b.f.s.state.operation=original
        receipt=self.b.f.s.receipt(raw['request_id']);self.assertEqual(receipt['state'],'completed')
        replay=self.b.f.s.command(raw);self.assertEqual(replay['ticket'],receipt['result']['ticket'])
        with closing(self.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_carrier_invites').fetchone()[0],1)

if __name__=='__main__':unittest.main(verbosity=2)
