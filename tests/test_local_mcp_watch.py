from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import json, os, socket, sys, tempfile, unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import local_mcp_watch as watch


class ConnectionWatchTests(unittest.TestCase):
    def controller(self, health=None, **kwargs):
        self.calls=[]; self.time=0
        controller=watch.ConnectionWatch(Path('C:/original'), 'a'*64,
            inspect_fn=lambda _: health or {'healthy':False,'components':{'union':'unavailable'},'owners':{'union':5}},
            eligible_fn=lambda *_: (True,'original_owner_absent'),
            recover_fn=lambda *_: self.calls.append('restore') or {'complete':True,'success':True,'reason':'recovered'},
            signature_fn=lambda _: 'a'*64, vpn_fn=lambda:True, idle_fn=lambda _:True,unknown_fn=lambda _:False, now=lambda:self.time, **kwargs)
        controller.preboot=lambda _:None
        return controller

    def test_healthy_observations_send_no_model_or_recovery(self):
        c=self.controller({'healthy':True,'components':{'union':'ready'},'owners':{'union':5}})
        self.assertEqual(c.tick()['state'],'healthy');self.assertEqual(self.calls,[])

    def test_missing_owner_uses_one_original_recovery_then_backs_off(self):
        c=self.controller();self.assertEqual(c.tick()['state'],'recovering')
        self.assertEqual(c.tick()['state'],'recovery_backoff');self.assertEqual(self.calls,['restore'])

    def test_entry_port_wait_after_preflight_does_not_consume_an_attempt(self):
        c=self.controller()
        c.recover=lambda *_: {'complete':True,'success':False,'reason':'backend_port_waiting'}
        for self.time in (0,30,600):
            waiting=c.tick();self.assertEqual(waiting['state'],'waiting_backend')
            self.assertEqual(waiting['attempts'],0);self.assertFalse(waiting['recovery_completion_unknown'])
        c.recover=lambda *_:self.calls.append('restore') or {'complete':True,'success':True,'reason':'recovered'}
        self.assertEqual(c.tick()['attempts'],1);self.assertEqual(self.calls,['restore'])

    def test_live_unresponsive_owner_is_retained(self):
        c=self.controller();c.eligible=lambda *_:(False,'live_owner_unavailable')
        self.assertEqual(c.tick()['reason'],'live_owner_unavailable');self.assertEqual(self.calls,[])

    def test_in_progress_source_is_never_loaded_by_recovery(self):
        c=self.controller();c.signature_fn=lambda _: 'b'*64
        self.assertEqual(c.tick()['reason'],'source_changed_restart_watch_after_verification')
        self.assertEqual(self.calls,[])

    def test_unknown_accepted_recovery_is_observed_without_replay(self):
        c=self.controller();c.recover=lambda *_:self.calls.append('restore') or {'complete':False,'success':False,'reason':'original_recovery_completion_unknown'}
        c.tick();self.time=200
        observed=c.tick()
        self.assertEqual(observed['reason'],'original_recovery_completion_unknown');self.assertEqual(self.calls,['restore'])
        self.assertTrue(observed['recovery_completion_unknown'])

    def test_three_failed_attempts_then_observation_manual_recovery_can_reset(self):
        c=self.controller();c.recover=lambda *_:self.calls.append('restore') or {'complete':True,'success':False,'reason':'original_recovery_failed'}
        for t in (0,10,30):self.time=t;c.tick()
        self.time=200;self.assertEqual(c.tick()['reason'],'recovery_retry_limit');self.assertEqual(len(self.calls),3)
        c.inspect=lambda _:{'healthy':True,'components':{},'owners':{}}
        self.assertEqual(c.tick()['attempts'],0)

    def test_runner_stale_alive_is_a_connection_wait_without_restart(self):
        health={'healthy':False,'components':{'Runner':'connection_wait'},'owners':{'Runner':9}}
        with patch.object(watch,'original_backend',return_value={'runner':9}):
            self.assertEqual(watch.recovery_eligibility(Path('C:/original'),health,observe=lambda _:[]),
                             (False,'runner_connection_wait'))

    def test_duplicate_current_service_under_different_pid_is_not_replaced(self):
        health={'healthy':False,'components':{'union':'unavailable'},'owners':{'union':9}}
        row={'ProcessId':10,'Name':'bun.exe','CreationFiletime':'123','ExecutablePath':'C:/original/.local/runtimes/bun-1.4.0/bun.exe',
            'CommandLine':'bun run C:\\original\\apps\\codex-web-bridge\\serve-union.cjs C:\\original\\.local\\codex-web-bridge\\union-config.json'}
        self.assertEqual(watch.recovery_eligibility(Path('C:/original'),health,observe=lambda _:[row]),
                         (False,'live_owner_unavailable'))

    def test_late_vpn_keeps_zero_budget_and_recovers_once_after_300_seconds(self):
        c=self.controller(); c.vpn=lambda:self.time>300
        c.inspect=lambda _:self.fail('Offline VPN must not read services')
        for self.time in (0,30,300,600):
            if self.time>300:break
            self.assertEqual(c.tick()['state'],'waiting_vpn');self.assertEqual(c.attempts,0)
        self.time=1800
        c.inspect=lambda _:{'healthy':False,'components':{'union':'unavailable'},'owners':{'union':5}}
        self.assertEqual(c.tick()['state'],'recovering');self.assertEqual(self.calls,['restore'])

    def test_original_recovery_mutex_does_not_spend_retries(self):
        c=self.controller();c.idle=lambda _:False
        for self.time in (0,30,600):self.assertEqual(c.tick()['state'],'waiting_original_recovery')
        self.assertEqual(c.attempts,0);self.assertEqual(self.calls,[])
        c.idle=lambda _:True;self.assertEqual(c.tick()['state'],'recovering')

    def test_vpn_edge_and_owner_change_reset_finite_budget_but_never_unknown(self):
        c=self.controller();c.recover=lambda *_:self.calls.append('restore') or {'complete':True,'success':False,'reason':'failed'}
        for self.time in (0,10,30):c.tick()
        self.time=600;self.assertEqual(c.tick()['reason'],'recovery_retry_limit')
        c.vpn=lambda:False;c.tick();c.vpn=lambda:True
        self.assertEqual(c.tick()['attempts'],1)
        c.completion_unknown=True;c.vpn=lambda:False;c.tick();c.vpn=lambda:True
        c.inspect=lambda _:{'healthy':False,'components':{'union':'unavailable'},'owners':{'union':20}}
        self.assertEqual(c.tick()['reason'],'original_recovery_completion_unknown');self.assertEqual(len(self.calls),4)
        c.completion_unknown=False;self.assertEqual(c.tick()['attempts'],1)

    def test_saved_pid_changes_do_not_reset_budget_but_real_creation_changes_do(self):
        c=self.controller();identities={'union':[],'A':[],'B':[],'desktop_A':[]}
        c.inspect=lambda _:{'healthy':False,'components':{'union':'unavailable'},'owners':{'union':5+len(self.calls)},'owner_identities':identities}
        c.recover=lambda *_:self.calls.append('restore') or {'complete':True,'success':False,'reason':'failed'}
        for self.time in (0,10,30):c.tick()
        self.time=200;self.assertEqual(c.tick()['reason'],'recovery_retry_limit');self.assertEqual(len(self.calls),3)
        identities['union']=[{'pid':9,'creation_filetime':'456'}]
        self.assertEqual(c.tick()['attempts'],1);self.assertEqual(len(self.calls),4)

    def test_initial_wrapper_unknown_receipt_survives_vpn_and_only_exact_healthy_run_settles(self):
        c=self.controller();c.unknown=lambda _:'e'*32
        self.assertEqual(c.tick()['reason'],'original_recovery_completion_unknown');self.assertEqual(self.calls,[])
        c.vpn=lambda:False;c.tick();c.vpn=lambda:True
        self.assertEqual(c.tick()['reason'],'original_recovery_completion_unknown')
        c.inspect=lambda _:{'healthy':True,'components':{},'owners':{}}
        healthy=c.tick();self.assertEqual(healthy['settled_recovery_run_id'],'e'*32)
        c.inspect=lambda _:{'healthy':False,'components':{'union':'unavailable'},'owners':{'union':5}}
        self.assertEqual(c.tick()['state'],'recovering');self.assertEqual(self.calls,['restore'])
        c.unknown=lambda _:'f'*32
        self.assertEqual(c.tick()['reason'],'original_recovery_completion_unknown');self.assertEqual(self.calls,['restore'])

    def test_unknown_and_settled_run_survive_offline_and_observation_error_records(self):
        c=self.controller();c.completion_unknown=True;c.settled_unknown='e'*32
        c.vpn=lambda:False
        offline=c.tick();self.assertTrue(offline['recovery_completion_unknown']);self.assertEqual(offline['settled_recovery_run_id'],'e'*32)
        c.vpn=lambda:True;c.inspect=lambda _:(_ for _ in ()).throw(RuntimeError('read unknown'))
        failed=c.tick();self.assertTrue(failed['recovery_completion_unknown']);self.assertEqual(failed['settled_recovery_run_id'],'e'*32)


class RecoveryReceiptTests(unittest.TestCase):
    def test_original_run_receipt_controls_completion_not_only_shell_exit(self):
        for scenario in ('complete','known_failed','waiting_backend','unknown','missing','wrong_run'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as raw:
                root=Path(raw);(root/'.local').mkdir()
                def run(command,**kwargs):
                    self.assertIn('-RecoveryRunId',command);self.assertNotIn('-StartWatch',command)
                    self.assertEqual(kwargs['timeout'],360)
                    run_id=command[command.index('-RecoveryRunId')+1]
                    if scenario!='missing':
                        receipt={'run_id':'f'*32 if scenario=='wrong_run' else run_id,'state':'completed' if scenario=='complete' else 'needs_attention','launch_unknown':scenario=='unknown'}
                        if scenario=='waiting_backend':receipt.update(state='waiting_backend',error_code='backend_port_waiting')
                        (root/('.local/ab-recovery-'+run_id+'.json')).write_text(json.dumps(receipt))
                    return SimpleNamespace(returncode=0 if scenario=='complete' else 1)
                with patch.object(watch,'run_bounded',side_effect=run):result=watch.recover(root,'fixture-shell')
                self.assertEqual(result['complete'],scenario in ('complete','known_failed','waiting_backend'))
                self.assertEqual(result['success'],scenario=='complete')
                if scenario=='waiting_backend':self.assertEqual(result['reason'],'backend_port_waiting')


class MissingBackendRecoveryTests(unittest.TestCase):
    def health(self):
        return {'healthy':False,
            'components':{'union':'ready','A':'not_ready','B':'ready','Server':'unavailable'},
            'owners':{'union':5,'A':7,'B':8,'Server':None,'Runner':None}}

    def owners(self):
        return {**{name:[{'pid':pid,'creation_filetime':'123','configuration_verified':True}]
            for name,pid in [('union',5),('A',7),('B',8)]},'desktop_A':[]}

    def eligible(self, health, *, backend=None, owners=None, listener_absent=True, bind_ready=True):
        with patch.object(watch,'logical_owners',return_value=self.owners() if owners is None else owners), \
                patch.object(watch,'original_backend',return_value={} if backend is None else backend), \
                patch.object(watch,'backend_config',return_value={'origin':'http://127.0.0.1:50842'}), \
                patch.object(watch,'listener_owned',return_value=listener_absent), \
                patch.object(watch.socket,'socket') as socket_factory:
            if not bind_ready:socket_factory.return_value.__enter__.return_value.bind.side_effect=OSError(10013,'fixture bind denied')
            return watch.recovery_eligibility(Path('C:/original'),health)

    def controller(self, **overrides):
        self.calls=[];self.time=0
        args={'inspect_fn':lambda _:self.health(),'eligible_fn':lambda _,health:self.eligible(health),
            'recover_fn':lambda *_:self.calls.append('original_recovery') or
                {'complete':True,'success':False,'reason':'original_recovery_failed'},
            'signature_fn':lambda _:'a'*64,'vpn_fn':lambda:True,'idle_fn':lambda _:True,
            'unknown_fn':lambda _:False,'now':lambda:self.time}
        args.update(overrides)
        result=watch.ConnectionWatch(Path('C:/original'),'a'*64,**args)
        result.preboot=lambda _:None
        return result

    def test_missing_backend_does_not_depend_on_live_tunnel_initialize(self):
        health=self.health();before=json.dumps(health,sort_keys=True)
        self.assertEqual(self.eligible(health),(True,'original_backend_absent'))
        self.assertEqual(json.dumps(health,sort_keys=True),before)
        controller=self.controller();self.assertEqual(controller.tick()['attempts'],1)
        self.assertEqual(self.calls,['original_recovery'])

    def test_blocked_backend_port_waits_with_zero_budget_then_recovers_once(self):
        controller=self.controller(eligible_fn=lambda _,health:self.eligible(health,bind_ready=self.time>=1800),
            recover_fn=lambda *_:self.calls.append('original_recovery') or {'complete':True,'success':True,'reason':'recovered'})
        for self.time in (0,30,600):
            waiting=controller.tick();self.assertEqual(waiting['state'],'waiting_backend')
            self.assertEqual(waiting['reason'],'backend_port_waiting')
            self.assertEqual(waiting['attempts'],0);self.assertEqual(self.calls,[])
        self.time=1800;self.assertEqual(controller.tick()['attempts'],1)
        self.assertEqual(self.calls,['original_recovery'])
        self.assertEqual(controller.tick()['state'],'recovery_backoff')

    def test_live_unavailable_backend_is_retained_and_never_called_absent(self):
        health=self.health()
        self.assertEqual(self.eligible(health,backend={'server':4}),
            (False,'live_owner_unavailable'))
        health['components']['Server']='ready';health['components']['Runner']='connection_wait'
        self.assertEqual(self.eligible(health,backend={'server':4,'runner':9}),
            (False,'runner_connection_wait'))
        self.assertEqual(self.eligible(health,backend={'server':4}),
            (True,'original_backend_absent'))

    def test_missing_backend_does_not_release_foreign_listener_or_ambiguous_tunnels(self):
        health=self.health()
        self.assertEqual(self.eligible(health,listener_absent=False),(False,'owner_changed'))
        owners=self.owners();owners['A'].append({'pid':70,'creation_filetime':'456'})
        self.assertEqual(self.eligible(health,owners=owners),(False,'owner_ambiguous'))
        owners=self.owners();owners['A'][0]['configuration_verified']=False
        self.assertEqual(self.eligible(health,owners=owners),(False,'owner_changed'))

    def test_tunnel_unavailable_with_ready_backend_still_does_not_restart(self):
        health=self.health();health['components']['Server']='ready';health['components']['Runner']='ready'
        self.assertEqual(self.eligible(health,backend={'server':4,'runner':9}),
            (False,'live_owner_unavailable'))

    def test_backend_native_observation_unknown_never_starts_recovery(self):
        controller=self.controller(eligible_fn=watch.recovery_eligibility)
        for error in ('backend_owner_ambiguous','backend_process_identity_unknown'):
            with self.subTest(error=error),patch.object(watch,'logical_owners',return_value=self.owners()), \
                    patch.object(watch,'original_backend',side_effect=ValueError(error)):
                self.assertEqual(controller.tick()['reason'],'connection_observation_unavailable')
                self.assertEqual(self.calls,[]);self.assertEqual(controller.attempts,0)

    def test_original_unknown_and_inflight_recoveries_still_block_missing_backend(self):
        controller=self.controller(unknown_fn=lambda _:'e'*32)
        self.assertEqual(controller.tick()['reason'],'original_recovery_completion_unknown')
        self.assertEqual(self.calls,[])
        controller=self.controller(idle_fn=lambda _:False)
        self.assertEqual(controller.tick()['state'],'waiting_original_recovery')
        self.assertEqual(self.calls,[]);self.assertEqual(controller.attempts,0)

    def test_missing_backend_keeps_three_attempt_budget_and_waits_for_late_vpn(self):
        controller=self.controller(vpn_fn=lambda:self.time>=1800)
        for self.time in (0,300,600):
            self.assertEqual(controller.tick()['state'],'waiting_vpn')
            self.assertEqual(controller.attempts,0);self.assertEqual(self.calls,[])
        for self.time in (1800,1810,1830):controller.tick()
        self.time=2000
        self.assertEqual(controller.tick()['reason'],'recovery_retry_limit')
        self.assertEqual(self.calls,['original_recovery']*3)


class BackendPortReadinessTests(unittest.TestCase):
    def test_exclusive_bind_uses_original_loopback_port_and_never_listens(self):
        with patch.object(watch,'original_backend',return_value={}), \
                patch.object(watch,'backend_config',return_value={'origin':'http://127.0.0.1:50842'}), \
                patch.object(watch,'listener_owned',return_value=True),patch.object(watch.socket,'socket') as factory:
            probe=factory.return_value.__enter__.return_value
            self.assertEqual(watch.backend_port_readiness(Path('C:/original')),(True,'backend_port_ready'))
            factory.assert_called_once_with(socket.AF_INET,socket.SOCK_STREAM)
            probe.bind.assert_called_once_with(('127.0.0.1',50842));probe.listen.assert_not_called()
            if os.name=='nt':probe.setsockopt.assert_called_once_with(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)

    def test_existing_server_and_foreign_listener_never_receive_bind_probe(self):
        with patch.object(watch,'original_backend',return_value={'server':4}), \
                patch.object(watch,'backend_config') as config,patch.object(watch.socket,'socket') as factory:
            self.assertEqual(watch.backend_port_readiness(Path('C:/original')),(True,'original_server_live'))
            config.assert_not_called();factory.assert_not_called()
        with patch.object(watch,'original_backend',return_value={}), \
                patch.object(watch,'backend_config',return_value={'origin':'http://127.0.0.1:50842'}), \
                patch.object(watch,'listener_owned',return_value=False),patch.object(watch.socket,'socket') as factory:
            self.assertEqual(watch.backend_port_readiness(Path('C:/original')),(False,'owner_changed'))
            factory.assert_not_called()


class BootRecoveryTests(unittest.TestCase):
    def evidence(self,receipt,**overrides):
        args={'boot_fn':lambda:{'boot_id':'a'*32,'boot_filetime':'134046144000000000'},
            'owners_fn':lambda _:{name:[] for name in ('union','A','B','desktop_A')},
            'backend_fn':lambda _:{},'listener_fn':lambda *_:True,
            'snapshot_fn':lambda:{},'origin_fn':lambda _:'http://127.0.0.1:50842'}
        args.update(overrides)
        return watch.preboot_service_evidence(Path('C:/fixture'),receipt,**args)

    def receipt(self):
        return {'protocol':1,'run_id':'e'*32,'launch_unknown':True,'model_sends':0,'business_state_changed':False,
            'started_at':'2025-01-01T00:00:00+00:00','boot':{'boot_id':'b'*32},
            'coordinator':{'ProcessId':42,'CreationFiletime':'123'}}

    def test_true_new_boot_requires_ended_coordinator_and_all_fixed_service_absence(self):
        receipt=self.receipt()
        self.assertEqual(self.evidence(receipt)['state'],'preboot_ended')
        self.assertIsNone(self.evidence({**receipt,'boot':{'boot_id':'a'*32}}))
        self.assertIsNone(self.evidence(receipt,snapshot_fn=lambda:{42:{}},coordinator_fn=lambda _:{'CreationFiletime':'123'}))
        self.assertIsNone(self.evidence(receipt,owners_fn=lambda _:{'A':[{'pid':8}]}))
        self.assertIsNone(self.evidence(receipt,backend_fn=lambda _:{'runner':8}))
        self.assertIsNone(self.evidence(receipt,listener_fn=lambda *_:False))
        self.assertIsNone(self.evidence({**receipt,'business_state_changed':True}))

    def test_legacy_needs_started_before_real_last_boot_and_never_missing_keys_only(self):
        receipt=self.receipt();receipt.pop('boot');receipt.pop('coordinator')
        self.assertTrue(self.evidence(receipt)['legacy_started_before_boot'])
        self.assertIsNone(self.evidence({**receipt,'started_at':'2030-01-01T00:00:00+00:00'}))
        with self.assertRaises(KeyError):self.evidence({key:value for key,value in receipt.items() if key!='started_at'})

    def test_watcher_releases_only_verified_preboot_service_run_and_keeps_same_boot_unknown(self):
        for ended in (None,{'run_id':'e'*32,'state':'preboot_ended'}):
            calls=[]
            controller=watch.ConnectionWatch(Path('C:/fixture'),'a'*64,
                inspect_fn=lambda _:{'healthy':False,'components':{'union':'unavailable'},'owners':{'union':5}},
                eligible_fn=lambda *_:(True,'original_owner_absent'),recover_fn=lambda *_:calls.append('restore') or {'complete':True,'success':True,'reason':'recovered'},
                signature_fn=lambda _:'a'*64,vpn_fn=lambda:True,idle_fn=lambda _:True,unknown_fn=lambda _:'e'*32)
            controller.completion_unknown=True;controller.preboot=lambda _:ended
            result=controller.tick()
            self.assertEqual(len(calls),0 if ended is None else 1)
            self.assertEqual(result['reason'],'original_recovery_completion_unknown' if ended is None else 'recovered')

    @unittest.skipUnless(os.name=='nt','Windows kernel boot metadata')
    def test_real_native_boot_identity_is_cached_and_predates_current_process(self):
        watch.boot_identity.cache_clear();first=watch.boot_identity();second=watch.boot_identity()
        self.assertIs(first,second);self.assertEqual(len(first['boot_id']),32)
        self.assertLess(int(first['boot_filetime']),int(watch.process_identity(os.getpid())['CreationFiletime']))


class ColdOwnerTests(unittest.TestCase):
    def row(self,root,role,pid=5):
        if role=='union':
            return {'Name':'bun.exe','ProcessId':pid,'CreationFiletime':'123','ExecutablePath':str(root/'.local/runtimes/bun-1.4.0/bun.exe'),
                    'CommandLine':'"bun.exe" run "'+str(root/'apps/codex-web-bridge/serve-union.cjs')+'" "'+str(root/'.local/codex-web-bridge/union-config.json')+'"'}
        profile=root/'.local/account-a-tunnel/profile.yaml'
        binary=Path(os.environ['LOCALAPPDATA'])/'WebCodex/tools/tunnel-client/0.0.12/windows-amd64/tunnel-client.exe'
        return {'Name':'tunnel-client.exe','ProcessId':pid,'CreationFiletime':'123','ExecutablePath':str(binary),
                'CommandLine':'"tunnel-client.exe" run --profile-file "'+str(profile)+'"'}

    def test_reused_old_pids_with_unrelated_argv_do_not_block_absent_original(self):
        root=Path('C:/original')
        health={'healthy':False,'components':{'union':'unavailable','A':'unavailable','B':'unavailable'},'owners':{'union':5,'A':7,'B':8}}
        rows=[{'Name':'bun.exe' if pid==5 else 'tunnel-client.exe','ProcessId':pid,'CreationFiletime':'999',
            'ExecutablePath':'C:/elsewhere/bun.exe','CommandLine':'bun run C:/elsewhere/script.cjs'} for pid in (5,7,8)]
        self.assertEqual(watch.recovery_eligibility(root,health,observe=lambda _:rows),(True,'original_owner_absent'))

    def test_exact_profile_and_desktop_handoff_are_distinct_and_duplicates_refused(self):
        root=Path('C:/original');managed=self.row(root,'A',7)
        desktop={**managed,'ProcessId':8,'CommandLine':'tunnel-client.exe run --profile-file "'+str(Path(os.environ['LOCALAPPDATA'])/'dev.webcodex.desktop/runtime/local/regular-tunnel-runtime/profile.yaml')+'"'}
        owners=watch.logical_owners(root,observe=lambda _:[desktop]);self.assertEqual(len(owners['desktop_A']),1);self.assertEqual(owners['A'],[])
        health={'components':{'A':'desktop_handoff'},'owners':{'A':7}}
        self.assertEqual(watch.recovery_eligibility(root,health,observe=lambda _:[desktop]),(True,'original_owner_absent'))
        for rows in ([managed,desktop],[managed,{**managed,'ProcessId':9}],[desktop,{**desktop,'ProcessId':9}]):
            self.assertEqual(watch.recovery_eligibility(root,health,observe=lambda _:rows),(False,'owner_ambiguous'))
        other={**managed,'CommandLine':managed['CommandLine'].replace('profile.yaml','profile.yaml-other')}
        self.assertEqual(watch.logical_owners(root,observe=lambda _:[other])['A'],[])

    def test_wrong_union_config_or_executable_is_unknown_owner_not_absence(self):
        root=Path('C:/original');row=self.row(root,'union')
        for changed in ({**row,'ExecutablePath':'C:/other/bun.exe'},
                        {**row,'CommandLine':row['CommandLine'].replace('union-config.json','other-config.json')}):
            health={'components':{'union':'unavailable'},'owners':{'union':5}}
            self.assertEqual(watch.recovery_eligibility(root,health,observe=lambda _:[changed]),(False,'owner_changed'))


class RuntimeHealthTests(unittest.TestCase):
    def fixture(self,root):
        home=root/'.local/codex-web-bridge';home.mkdir(parents=True)
        key=root/'auth.txt';key.write_text('private-bootstrap-key')
        (home/'shared-entry.json').write_text(json.dumps({'unionPid':5,'tunnelPid':8,'url':'http://127.0.0.1:18945/mcp','upstream':'http://127.0.0.1:50842/mcp'}))
        (home/'union-config.json').write_text(json.dumps({'port':18945,'target':'http://127.0.0.1:50842/mcp','authorizationFile':str(key)}))
        (home/'settings.json').write_text(json.dumps({'tunnel':{'tunnelId':'tunnel_'+'b'*32}}))
        for account,pid in [('a',7),('b',8)]:
            d=root/('.local/account-'+account+'-tunnel');d.mkdir()
            (d/'owner.json').write_text(json.dumps({'pid':pid,'tunnelId':'tunnel_'+account*32}))
            (d/'health-url.txt').write_text('http://127.0.0.1:'+str(20000+pid))
        self.age=2;self.projects=124;self.status='ready';self.transport='connected'
        def read(url,**kwargs):
            if url.endswith('/metrics'):
                clock=watch.time.time()
                return 'process_start_time_seconds '+str(clock-1000)+'\ncommands_poll_last_successful_timestamp_seconds '+str(clock-2)+'\n'
            if url.endswith('/mcp'):
                self.assertEqual(kwargs['headers']['authorization'],'private-bootstrap-key')
                return json.dumps({'result':{'structuredContent':{'success':True,'output':{
                    'connection_layers':{'runner_process':{'status':self.status,'agent_instance_id':'original-runner'},
                        'server_transport':{'status':self.transport,'age_secs':self.age,'observed_at':1234},
                        'project_registry':{'online_projects':self.projects}},
                    'agents':{'online_count':1},'jobs':{'active_count':2}}}}})
            if '18945' in url:return json.dumps({'service':'clw-mcp-union','pid':5})
            return 'ready' if url.endswith('/readyz') else 'live'
        return read

    def inspect(self,root,read,backend):
        owners={name:[{'pid':pid,'creation_filetime':'123'}] for name,pid in [('union',5),('A',7),('B',8)]}
        owners['desktop_A']=[]
        return watch.inspect(root,read=read,backend=backend,owners_fn=lambda _:owners,listener_fn=lambda *_:True)

    def test_ready_endpoints_with_missing_or_stale_poll_are_not_healthy(self):
        for timestamp,state in [(0,'poll_not_seen'),(watch.time.time()-7200,'poll_stale')]:
            with self.subTest(state=state),tempfile.TemporaryDirectory() as raw:
                root=Path(raw);read=self.fixture(root)
                def stale(url,**kwargs):
                    if url.endswith('/metrics'):return 'commands_poll_last_successful_timestamp_seconds '+str(timestamp)+'\n'
                    return read(url,**kwargs)
                result=self.inspect(root,stale,lambda _:{'runner':9,'server':4})
                self.assertFalse(result['healthy'])
                self.assertEqual(result['components']['A'],state)
                self.assertEqual(result['components']['B'],state)
                self.assertEqual(result['components']['Runner'],'ready')

    def test_old_auth_error_counter_does_not_hide_a_fresh_success(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            def recovered(url,**kwargs):
                value=read(url,**kwargs)
                if url.endswith('/metrics'):value+='http_client_request_duration_seconds_count{http_response_status_code="401"} 700\n'
                return value
            result=self.inspect(root,recovered,lambda _:{'runner':9,'server':4})
            self.assertTrue(result['healthy'])

    def test_compact_runner_health_keeps_exact_age_owner_and_active_jobs(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            result=self.inspect(root,read,lambda _:{'runner':9,'server':4})
            self.assertTrue(result['healthy']);self.assertEqual(result['owners']['Runner'],9)
            self.assertEqual(result['runner']['active_jobs'],2)
            self.assertEqual(result['server_transport']['observed_at'],1234)
            self.assertNotIn('private-bootstrap-key',json.dumps(result))

    def test_runner_probe_timeout_is_unknown_observation_not_an_offline_owner(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            def delayed(url,**kwargs):
                if url.endswith('/mcp'):raise TimeoutError('private endpoint')
                return read(url,**kwargs)
            result=self.inspect(root,delayed,lambda _:{'runner':9,'server':4})
            self.assertFalse(result['healthy'])
            self.assertEqual(result['components']['Runner'],'observation_unavailable')
            self.assertEqual(result['runner_observation']['reason'],'runner_probe_timeout')
            self.assertEqual(result['owners']['Runner'],9)
            self.assertNotIn('private endpoint',json.dumps(result))
            result=self.inspect(root,read,lambda _:{'runner':9,'server':4})
            self.assertTrue(result['healthy']);self.assertEqual(result['owners']['Runner'],9)

    def test_stale_heartbeat_and_zero_online_inventory_never_report_healthy(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            for age,projects,status,transport in [(142,124,'ready','connected'),(2,0,'ready','connected'),(2,124,'stale','disconnected')]:
                self.age=age;self.projects=projects;self.status=status;self.transport=transport
                result=self.inspect(root,read,lambda _:{'runner':9,'server':4})
                self.assertFalse(result['healthy']);self.assertEqual(result['components']['Runner'],'connection_wait')

    def test_lost_backend_is_a_missing_owner_not_a_fake_connected_runner(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            result=self.inspect(root,read,lambda _: {})
            self.assertFalse(result['healthy']);self.assertEqual(result['components']['Server'],'unavailable')

    def test_cold_boot_ignores_old_random_health_urls_and_foreign_fixed_union_is_refused(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root);calls=[]
            def traced(url,**kwargs):calls.append(url);return read(url,**kwargs)
            absent={name:[] for name in ('union','A','B','desktop_A')}
            result=watch.inspect(root,read=traced,backend=lambda _: {},owners_fn=lambda _:absent,listener_fn=lambda *_:True)
            self.assertFalse(result['healthy']);self.assertEqual(calls,[])
            with patch.object(watch,'original_backend',return_value={}), \
                    patch.object(watch,'backend_config',return_value={'origin':'http://127.0.0.1:50842'}), \
                    patch.object(watch,'listener_owned',return_value=True),patch.object(watch.socket,'socket'):
                self.assertEqual(watch.recovery_eligibility(root,result,observe=lambda _:[]),(True,'original_backend_absent'))
            foreign=watch.inspect(root,read=traced,backend=lambda _: {},owners_fn=lambda _:absent,listener_fn=lambda *_:False)
            self.assertEqual(foreign['components']['union'],'owner_changed')
            self.assertEqual(watch.recovery_eligibility(root,foreign,observe=lambda _:[]),(False,'owner_changed'))

    def test_current_process_with_old_health_listener_or_birth_change_never_becomes_healthy(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);read=self.fixture(root)
            owners={name:[{'pid':pid,'creation_filetime':'123'}] for name,pid in [('union',5),('A',7),('B',8)]};owners['desktop_A']=[]
            for scenario in ('foreign_health','birth_changed','new_owner'):
                counts={}
                def listener(url,owner):
                    counts[url]=counts.get(url,0)+1
                    return not ('20007' in url and (scenario=='foreign_health' or scenario=='birth_changed' and counts[url]>1))
                if scenario=='new_owner':owners['A'][0]['pid']=70
                result=watch.inspect(root,read=read,backend=lambda _:{'runner':9,'server':4},owners_fn=lambda _:owners,listener_fn=listener)
                self.assertFalse(result['healthy'])
                self.assertEqual(result['components']['A'],'owner_changed' if scenario=='new_owner' else 'unavailable')

    @unittest.skipUnless(os.name=='nt','Windows native listener contract')
    def test_real_dynamic_listener_requires_exact_pid_creation_and_positive_absence(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            origin='http://127.0.0.1:'+str(listener.getsockname()[1])
            identity=watch.process_identity(os.getpid())
            owner={'pid':os.getpid(),'creation_filetime':identity['CreationFiletime']}
            self.assertTrue(watch.listener_owned(origin,owner))
            self.assertFalse(watch.listener_owned(origin,{**owner,'pid':os.getpid()+1}))
            self.assertFalse(watch.listener_owned(origin,{**owner,'creation_filetime':str(int(identity['CreationFiletime'])+1)}))
            self.assertFalse(watch.listener_owned(origin,None))
        self.assertTrue(watch.listener_owned(origin,None))


if __name__=='__main__':unittest.main()
