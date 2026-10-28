from pathlib import Path
import copy,json,sys,tempfile,threading,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_domain import TaskError,fingerprint
from task_store import TaskStore
from test_task_store import example,Observe
from specialist_service import Specialists
from coding_agent_bridge import NativeAgentBridge,safe_projection
from live_transport import Transport
from specialist_fixture import FakeNative,NativeHTTP,P

class SpecialistTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'tasks.sqlite3';self.store=TaskStore(self.path,Observe());self.bridge=FakeNative();self.service=Specialists(self.store,self.bridge)
        c=example('codex');c['roles'][0]['scopes']=['.']
        self.task=self.store.command({'request_id':str(uuid.uuid4()),'action':'create','actor':'tester','data':{'contract':c}})['task']
        self.regular('publish',{});self.regular('claim',{'role_id':'A','external_ref':'explicit optional specialist'})
    def tearDown(self):self.temp.cleanup()
    def refresh(self):self.task=self.store.get(self.task['id']);return self.task
    def regular(self,action,data):
        self.refresh();self.task=self.store.command({'request_id':str(uuid.uuid4()),'action':action,'actor':'tester','task_id':self.task['id'],'expected_version':self.task['version'],'data':data})['task'];return self.task
    def raw(self,action,data=None):
        self.refresh();return {'request_id':str(uuid.uuid4()),'action':action,'actor':'tester','task_id':self.task['id'],'expected_version':self.task['version'],'data':data or {'role_id':'A'}}
    def prepdata(self):return {'role_id':'A','provider':'codex','binding':self.bridge.binding,'config':{'model':'explicit-model','reasoning_effort':'high','mode':'agent'},'billing':'work_codex','account_alias':'operator-labelled account'}
    def prepare(self):return self.service.command(self.raw('prepare',self.prepdata()))
    def start(self):return self.service.command(self.raw('start',{'role_id':'A','confirmed':True}))
    def d(self):return self.refresh()['roles']['A']['delegation']
    def test_prepare_never_dispatches_and_preserves_full_goal(self):
        self.prepare();d=self.d();self.assertIn(self.task['contract']['goal'],d['instruction']);self.assertEqual(d['phase'],'prepared');self.assertEqual(self.bridge.calls,[])
    def test_start_inherits_no_silent_defaults(self):
        self.prepare();self.start();tool,p=self.bridge.calls[0];self.assertEqual(tool,'coding_agent_start');self.assertEqual(p['config'],self.prepdata()['config']);self.assertIsNone(self.d()['effective_model'])
    def test_start_receipt_replay_never_resends(self):
        self.prepare();r=self.raw('start',{'role_id':'A','confirmed':True});self.service.command(r);self.service.command(r);self.assertEqual(len(self.bridge.calls),1)
    def test_duplicate_prepare_returns_original_identity(self):
        r=self.raw('prepare',self.prepdata());self.service.command(r);d=self.d();self.service.command(r);self.assertEqual(d,self.d())
    def test_ui_key_cannot_be_reused_with_different_input(self):
        r=self.raw('prepare',self.prepdata());self.service.command(r);r['data']['config']['model']='other'
        with self.assertRaises(TaskError):self.service.command(r)
    def test_disabled_execution_cannot_be_enabled_in_data(self):
        self.prepare();self.bridge.enabled=False
        with self.assertRaises(TaskError):self.start()
        self.assertEqual(self.bridge.calls,[]);self.assertEqual(self.d()['phase'],'prepared')
    def test_confirmation_required(self):
        self.prepare()
        with self.assertRaises(TaskError):self.service.command(self.raw('start'))
        self.assertEqual(self.bridge.calls,[])
    def test_no_provider_no_prepare(self):
        self.bridge.provider=False
        with self.assertRaises(TaskError):self.prepare()
        self.assertNotIn('delegation',self.refresh()['roles']['A'])
    def test_actual_project_root_must_match(self):
        self.store.observer.path='D:/another'
        with self.assertRaises(TaskError):self.prepare()
    def test_no_independent_api_dispatch(self):
        data=self.prepdata();data['billing']='api'
        with self.assertRaises(TaskError):self.service.command(self.raw('prepare',data))
    def test_no_executable_or_arbitrary_config(self):
        for field in ['executable','env','approval_policy']:
            data=self.prepdata();data['config'][field]='danger'
            with self.assertRaises(TaskError):self.service.command(self.raw('prepare',data))
    def test_narrow_write_scope_not_misrepresented_as_native_sandbox(self):
        self.regular('release',{'role_id':'A','reason':'no work'});self.regular('revise',{'contract':example('codex'),'reason':'narrow scope'});self.regular('publish',{});self.regular('claim',{'role_id':'A','external_ref':'handoff only'})
        with self.assertRaises(TaskError):self.prepare()
        self.assertEqual(self.bridge.calls,[])
    def test_read_role_cannot_request_write_mode(self):
        self.regular('release',{'role_id':'A','reason':'no work'});c=example('codex');c['roles'][0]['access']='read';c['roles'][0]['scopes']=[];self.regular('revise',{'contract':c,'reason':'review'});self.regular('publish',{});self.regular('claim',{'role_id':'A','external_ref':'review'})
        with self.assertRaises(TaskError):self.prepare()
        data=self.prepdata();data['config']['mode']='read-only';self.service.command(self.raw('prepare',data))
    def test_prepared_and_running_roles_cannot_release_or_submit(self):
        self.prepare()
        for phase in ['prepared','running']:
            for action in ['release','submit']:
                with self.assertRaises(TaskError):self.regular(action,{'role_id':'A','reason':'not finished'})
            if phase=='prepared':self.start()
    def test_unknown_reply_persists_across_restart_and_same_key_recovers(self):
        self.prepare();key=self.d()['key'];self.bridge.lose_once=True;self.start();self.assertEqual(self.d()['phase'],'unknown');self.assertIsNone(self.d()['run_id'])
        self.store=TaskStore(self.path,Observe());self.service=Specialists(self.store,self.bridge)
        with self.assertRaises(TaskError):self.prepare()
        self.service.command(self.raw('retry_start',{'role_id':'A','confirmed':True}));self.assertEqual(self.d()['key'],key);self.assertEqual(len(self.bridge.runs),1)
    def test_known_run_must_observe_not_replay_start(self):
        self.prepare();self.start()
        with self.assertRaises(TaskError):self.service.command(self.raw('retry_start',{'role_id':'A','confirmed':True}))
    def test_uncertain_start_does_not_retarget_provider_instance(self):
        self.prepare();self.bridge.lose_once=True;self.start();self.bridge.binding='changed'
        with self.assertRaises(TaskError):self.service.command(self.raw('retry_start',{'role_id':'A','confirmed':True}))
        self.assertEqual(len(self.bridge.calls),1)
    def test_connection_identity_change_blocks_observation(self):
        self.prepare();self.start();self.bridge.namespace='another-account'
        with self.assertRaises(TaskError):self.service.command(self.raw('observe'))
    def test_structured_not_started_does_not_lock_forever(self):
        self.prepare();self.bridge.reject=True;self.start();self.assertEqual(self.d()['phase'],'not_started');self.regular('release',{'role_id':'A','reason':'native rejected before prompt'})
    def test_mismatched_reply_preserves_uncertainty_and_ownership(self):
        self.prepare();self.bridge.wrong_identity=True;self.start();self.assertEqual(self.d()['phase'],'unknown')
        with self.assertRaises(TaskError):self.regular('release',{'role_id':'A','reason':'wrong identity'})
    def test_terminal_required_before_handoff_and_parent_acceptance(self):
        self.prepare();self.start();self.bridge.mode='completed';self.bridge.execution='completed';self.service.command(self.raw('observe'));self.assertEqual(self.d()['phase'],'completed');self.assertEqual(self.task['status'],'open');self.assertEqual(self.task['roles']['A']['status'],'running')
        self.regular('submit',{'role_id':'A','contract_version':1,'summary':'done','changes':'ref','tests':'actual evidence','limitations':'','artifacts':'reference','stopped_writing':True});self.assertEqual(self.task['status'],'open')
    def test_cancel_ack_needs_later_observation(self):
        self.prepare();self.start();self.bridge.mode='cancelled';self.bridge.execution='completed';self.service.command(self.raw('cancel',{'role_id':'A','confirmed':True}));self.assertEqual(self.d()['phase'],'running')
        with self.assertRaises(TaskError):self.regular('release',{'role_id':'A','reason':'not observed'})
        self.service.command(self.raw('observe'));self.assertEqual(self.d()['phase'],'cancelled')
    def test_prepared_abandon_is_local_and_safe(self):
        self.prepare();self.service.command(self.raw('abandon'));self.assertEqual(self.bridge.calls,[]);self.regular('release',{'role_id':'A','reason':'abandoned'})
    def test_cannot_abandon_dispatched_run(self):
        self.prepare();self.start()
        with self.assertRaises(TaskError):self.service.command(self.raw('abandon'))
    def test_lost_run_remains_locked(self):
        self.prepare();self.start();self.bridge.mode='lost';self.bridge.execution='outcome_unknown';self.service.command(self.raw('observe'));self.assertEqual(self.d()['phase'],'unknown')
        with self.assertRaises(TaskError):self.regular('release',{'role_id':'A','reason':'lost'})
    def test_internal_update_not_available_through_task_command(self):
        with self.assertRaises(TaskError):self.regular('specialist.result',{'role_id':'A','phase':'completed'})
    def test_late_result_cannot_clear_newer_operation(self):
        self.prepare();self.start();d=self.d();self.assertFalse(self.store.specialist_result(self.task['id'],'A',d['id'],'old-op',{'phase':'completed'}));self.assertEqual(self.d()['phase'],'running')
    def test_two_product_instances_only_one_initial_start(self):
        self.prepare();raw=self.raw('start',{'role_id':'A','confirmed':True});other=Specialists(TaskStore(self.path,Observe()),self.bridge)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda svc:svc.command(raw),[self.service,other]))
        self.assertEqual(len(self.bridge.calls),1);self.assertEqual(len(self.bridge.runs),1)
    def test_snapshot_usage_is_latest_not_event_sum_or_official_quota(self):
        self.prepare();self.start();self.bridge.events=[{'sequence':i,'kind':'usage','usage':{'used_tokens':i*100,'cost_amount':str(i)+'.50','cost_currency':'USD'}} for i in (1,2)];self.service.command(self.raw('observe'))
        self.assertEqual(self.d()['usage']['used_tokens'],200);self.assertEqual(self.d()['usage']['cost_amount'],'2.50');self.service.command(self.raw('observe'));self.assertEqual(self.d()['usage']['cost_amount'],'2.50')
    def test_reasoning_and_raw_tool_text_never_persisted(self):
        self.prepare();self.start();self.bridge.events=[{'sequence':1,'kind':'reasoning','text':'sensitive fixture reasoning'}];self.service.command(self.raw('observe'));self.assertNotIn('sensitive fixture reasoning',json.dumps(self.d()))
    def test_write_intent_durable_before_native_call(self):
        self.prepare();old=self.bridge.call
        def inspect(tool,p):self.assertEqual(TaskStore(self.path).get(self.task['id'])['roles']['A']['delegation']['phase'],'dispatching');return old(tool,p)
        self.bridge.call=inspect;self.start()
    def test_later_not_started_denial_does_not_clear_earlier_unknown_start(self):
        self.prepare();self.bridge.lose_once=True;self.start();self.bridge.reject=True
        self.service.command(self.raw('retry_start',{'role_id':'A','confirmed':True}))
        self.assertEqual(self.d()['phase'],'unknown')
        with self.assertRaises(TaskError):self.regular('release',{'role_id':'A','reason':'later denial is not original nonexecution'})
    def test_correlated_pre_prompt_terminal_is_not_unknown(self):
        self.prepare();self.bridge.mode='failed';self.bridge.execution='not_started';self.start()
        self.assertEqual(self.d()['phase'],'not_started');self.regular('release',{'role_id':'A','reason':'exact native pre-prompt failure'})
    def test_cumulative_usage_without_new_sequence_never_replaces_newer(self):
        self.prepare();self.start();self.bridge.events=[{'sequence':3,'kind':'usage','usage':{'used_tokens':900}}];self.service.command(self.raw('observe'))
        self.bridge.events=[{'sequence':1,'kind':'usage','usage':{'used_tokens':100}}];self.service.command(self.raw('observe'));self.assertEqual(self.d()['usage']['used_tokens'],900)
    def test_project_mapping_rechecked_immediately_before_start(self):
        self.prepare();self.store.observer.path='D:/changed'
        with self.assertRaises(TaskError):self.start()
        self.assertEqual(self.bridge.calls,[])
    def test_empty_terminal_cannot_release_ownership(self):
        self.prepare();self.start();old=self.bridge.call
        def missing(tool,p):
            r=old(tool,p);r['output'].update(state='completed',execution_state='completed',terminal={});return r
        self.bridge.call=missing;self.service.command(self.raw('observe'));self.assertEqual(self.d()['phase'],'running')
        self.assertIn('未确认',self.d()['observation_error'])
        with self.assertRaises(TaskError):self.regular('release',{'role_id':'A','reason':'invalid terminal'})
    def test_unattended_execution_enable_does_not_read_connection(self):
        import serve_control_center
        with patch.object(sys,'argv',['serve','--enable-codex-specialists']),patch('sys.stdin.isatty',return_value=False),patch('serve_control_center.configuration',side_effect=AssertionError('must not read')):
            with self.assertRaises(SystemExit) as e:serve_control_center.main()
        self.assertIn('interactive confirmation',str(e.exception))
    def test_source_change_rejects_stale_preparation(self):
        raw=self.raw('prepare',self.prepdata());self.regular('checkpoint',{'role_id':'A','completed':'x','remaining':'y','next_step':'z','original_jobs':''})
        with self.assertRaises(TaskError):self.service.command(raw)

class NativeTransportTests(unittest.TestCase):
    def setUp(self):self.fixture=NativeHTTP();self.bridge=NativeAgentBridge(Transport(self.fixture.origin,'wck_'+'fixture'*6,'test'),enabled=True)
    def tearDown(self):self.fixture.close()
    def test_actual_http_provider_discovery(self):
        d=self.bridge.discover(P);self.assertTrue(d['available']);self.assertEqual(d['providers'][0]['id'],'codex');self.assertNotIn('instance-1',json.dumps(d))
    def test_no_provider_not_inferred_from_executable(self):self.fixture.fake.provider=False;self.assertFalse(self.bridge.discover(P)['available'])
    def test_arbitrary_tool_not_forwarded(self):
        with self.assertRaises(TaskError):self.bridge.call('run_shell',{})
        self.assertEqual(self.fixture.requests,[])
    def test_disabled_start_does_not_reach_http(self):
        self.bridge.enabled=False
        with self.assertRaises(TaskError):self.bridge.call('coding_agent_start',{})
        self.assertEqual(self.fixture.requests,[])
    def test_auth_denial_never_retries(self):
        self.fixture.reject_auth=True
        with self.assertRaises(TaskError):self.bridge.call('coding_agent_start',{})
        self.assertEqual(len(self.fixture.requests),1)
    def test_redirect_does_not_forward_credentials(self):
        self.fixture.redirect=True
        with self.assertRaises(Exception):self.bridge.call('coding_agent_start',{})
        self.assertEqual(len(self.fixture.requests),1)
    def test_malformed_reply_never_retries(self):
        self.fixture.bad_body=True
        with self.assertRaises(TaskError):self.bridge.call('list_runners',{})
        self.assertEqual(len(self.fixture.requests),1)
    def test_missing_public_details_never_guesses_codex(self):
        self.fixture.omit_provider_details=True;d=self.bridge.discover(P)
        self.assertTrue(d['native_run_capability']);self.assertFalse(d['provider_details_available']);self.assertFalse(d['available'])
    def test_explicit_local_id_is_candidate_not_verified_provider(self):
        self.fixture.omit_provider_details=True
        b=NativeAgentBridge(self.bridge.transport,provider_ids=['codex']);d=b.discover(P)
        self.assertTrue(d['available']);self.assertFalse(d['providers'][0]['advertisement_verified']);self.assertEqual(d['providers'][0]['source'],'operator_declared_native_preflight');self.assertFalse(d['enabled'])
    def test_declared_provider_does_not_fake_native_capability(self):
        self.fixture.omit_provider_details=True;self.fixture.fake.provider=False
        self.assertFalse(NativeAgentBridge(self.bridge.transport,provider_ids=['codex']).discover(P)['available'])
    def test_explicit_advertisement_omission_is_not_override(self):
        b=NativeAgentBridge(self.bridge.transport,provider_ids=['foreign'])
        self.assertEqual([p['id'] for p in b.discover(P)['providers']],['codex'])
    def test_local_provider_reference_is_not_command_or_url(self):
        for value in ['http://outside','codex --unsafe','../provider']:
            with self.assertRaises(ValueError):NativeAgentBridge(self.bridge.transport,provider_ids=[value])
    def test_real_length_run_handle_is_not_a_runner_credential(self):
        from task_domain import bounded
        handle='wc_agent_run_'+'a'*64
        self.assertEqual(bounded({'run_id':handle})['run_id'],handle)
    def test_genuine_runner_credential_still_refused(self):
        from task_domain import bounded
        with self.assertRaises(TaskError):bounded({'note':'wc_agent_'+'a'*64})
    def test_exact_wire_payload(self):
        p={'project':P,'provider_id':'codex','idempotency_key':'original','instruction':'full goal','config':{'model':'explicit'},'timeout_secs':3600};self.bridge.call('coding_agent_start',p)
        self.assertEqual(self.fixture.requests[0],('/api/tools/call',{'tool':'coding_agent_start','params':p}))
if __name__=='__main__':unittest.main(verbosity=2)
