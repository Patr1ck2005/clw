from __future__ import annotations
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'tests'))
from live_transport import Transport,ObservationError,validate_origin,validate_token,configuration,READ_PATHS,MAX_BODY
from live_observer import Observer,selection
from serve_control_center import create_server
from live_fixture import Fixture,TOKEN,P1,P2,S1,S2,OLD,session,activity

class NativeSessionTests(unittest.TestCase):
 def test_compact_session_selection_preserves_exact_id(self):
  sid='wc_sess_xtZ-pHxMTJ2jI0ap'
  self.assertEqual(selection(P1,sid)['session'],sid)
 def test_compact_session_is_retained_in_list_detail_and_job(self):
  sid='wc_sess_xtZ-pHxMTJ2jI0ap';f=Fixture()
  try:
   f.overrides['/api/runtime-console/workflow-sessions']=(200,{'sessions':[session(sid)],'total':1,'returned':1,'truncated':False},{})
   f.overrides['/api/jobs/list']=(200,{'success':True,'output':{'jobs':[{'job_id':'wc_job_ku662cN9lti_enC9','project':P1,'session_id':sid,'status':'completed','exit_code':0}],'matched_count':1,'truncated':False}},{})
   result=Observer(Transport(f.origin,TOKEN,'test-runner'),cache_secs=0).state(P1,sid)
   self.assertEqual(result['state'],'connected')
   self.assertEqual(result['projection']['sessions'][0]['id'],sid)
   self.assertTrue(result['projection']['sessions'][0]['activities_loaded'])
   self.assertEqual(result['projection']['jobs'][0]['session_id'],sid)
  finally:f.close()
 def test_legacy_ids_are_preserved_without_normalization(self):
  for sid in ('wc_sess_c6057d51e0aa4002ac50b4d56c060977',S1,OLD):
   with self.subTest(sid=sid):self.assertEqual(selection(P1,sid)['session'],sid)
 def test_compact_id_does_not_allow_bad_length_or_control_characters(self):
  for sid in ('wc_sess_a-b','wc_sess_xtZ-pHxMTJ2jI0a','wc_sess_xtZ-pHxMTJ2jI0app','wc_sess_xtZ-pHxMTJ2jI0ap\n','wc_sess_xtZ/pHxMTJ2jI0ap','wc_sess_'):
   with self.subTest(sid=sid):
    with self.assertRaises(ObservationError):selection(P1,sid)

class ConfigTests(unittest.TestCase):
 def test_only_explicit_loopback_http(self):
  self.assertEqual(validate_origin('http://127.0.0.1:8000/'),'http://127.0.0.1:8000')
  for url in ['https://example.com','http://localhost:12','http://127.0.0.1:80/path','http://user:x@127.0.0.1:1','http://127.0.0.1:1?x','file:///x','http://127.0.0.1:0','http://127.0.0.1:99999']:
   with self.assertRaises(ValueError):validate_origin(url)
 def test_no_platform_key_or_runner_token(self):
  for token in ['sk-'+('X'*32),'wc_agent_'+('X'*32),'secret',TOKEN+'\n']:
   with self.assertRaises(ValueError):validate_token(token)
  self.assertEqual(validate_token(TOKEN),TOKEN)
 def test_only_explicit_reference(self):
  with tempfile.TemporaryDirectory() as td:
   file=Path(td)/'connection.json';self.assertIsNone(configuration(file))
   file.write_text(json.dumps({'schema_version':1,'server_url':'http://127.0.0.1:8000','token':TOKEN}))
   with self.assertRaises(ValueError):configuration(file)
 def test_environment_config_never_serializes_secret(self):
  with tempfile.TemporaryDirectory() as td:
   key='CLW_FIXTURE_TOKEN';prior=os.environ.get(key);os.environ[key]=TOKEN
   try:
    p=Path(td)/'connection.json';p.write_text(json.dumps({'schema_version':1,'server_url':'http://127.0.0.1:8000','token_env':key}))
    t=configuration(p);self.assertEqual(t.origin,'http://127.0.0.1:8000');self.assertNotIn(TOKEN,json.dumps(Observer(t).info()))
   finally:
    if prior is None:os.environ.pop(key,None)
    else:os.environ[key]=prior
 def test_credential_namespace_is_separated(self):
  a=Transport('http://127.0.0.1:9000',TOKEN);b=Transport('http://127.0.0.1:9000',TOKEN+'2')
  self.assertNotEqual(a.namespace,b.namespace);self.assertNotIn(TOKEN,a.namespace)
 def test_invalid_selection_never_dispatches(self):
  for args in [('',S1,''),(P1,'made-up',''),(P1,S1,'x'*201),(P1+'\n',S1,'')]:
   with self.assertRaises(ObservationError):selection(*args)

 def test_explicit_runner_reference_reuses_no_secret_copy(self):
  with tempfile.TemporaryDirectory() as td:
   runner=Path(td)/'runner.toml';runner.write_text('server_url = "http://127.0.0.1:8000"\ntoken = "'+TOKEN+'"\nclient_id = "chosen-runner"\n')
   cfg=Path(td)/'connection.json';cfg.write_text(json.dumps({'schema_version':1,'runner_config':str(runner.resolve())}))
   transport=configuration(cfg);self.assertEqual(transport.client_id,'chosen-runner');self.assertNotIn(TOKEN,cfg.read_text())
 def test_managed_runner_secret_not_repurposed(self):
  with tempfile.TemporaryDirectory() as td:
   runner=Path(td)/'runner.toml';runner.write_text('server_url = "http://127.0.0.1:8000"\ntoken = "wc_agent_synthetic_test_runner_123456789"\n')
   cfg=Path(td)/'connection.json';cfg.write_text(json.dumps({'schema_version':1,'runner_config':str(runner.resolve())}))
   with self.assertRaises(ValueError):configuration(cfg)

class AdapterTests(unittest.TestCase):
 def setUp(self):self.f=Fixture();self.t=Transport(self.f.origin,TOKEN,'test-runner',timeout=0.4,sleep=lambda _:None);self.o=Observer(self.t,cache_secs=0)
 def tearDown(self):self.f.close()
 def force(self,o=None):
  for slot in (o or self.o).slots.values():slot.deadline=0
 def test_native_projection_and_job_accepted_not_completed(self):
  x=self.o.state(P1,S1);self.assertEqual(x['state'],'connected');s=x['projection']['sessions'][0]
  self.assertFalse(s['counts_available']);self.assertEqual(s['activities'][0]['execution_state'],'running');self.assertIsNone(s['activities'][0]['exit_code'])
  self.assertFalse(x['coverage']['native_event_cursor']);self.assertEqual({r['path'] for r in self.f.requests},set(READ_PATHS.values()))
  self.assertTrue(all(r['cookie'] is None and r['authorization_ok'] for r in self.f.requests))
 def test_no_selected_project_never_reads_sessions(self):
  x=self.o.state();self.assertEqual(len(x['projection']['projects']),2);self.assertEqual(x['projection']['sessions'],[])
  self.assertEqual(len(self.f.requests),2)
 def test_view_revision_only_changes_with_data(self):
  a=self.o.state(P1,S1);b=self.o.state(P1,S1,after=a['revision']);self.assertTrue(b['unchanged']);self.assertIsNone(b['projection'])
  self.f.change=2;c=self.o.state(P1,S1,after=a['revision']);self.assertFalse(c['unchanged']);self.assertNotEqual(c['revision'],a['revision'])
 def test_evicted_view_never_reuses_old_revision(self):
  a=self.o.state(P1,S1)
  for i in range(25):self.o.state(query=f'eviction-view-{i}')
  self.assertLessEqual(len(self.o.slots),24)
  self.f.change=99
  b=self.o.state(P1,S1,after=a['revision'])
  self.assertFalse(b['unchanged'],'an evicted view has no valid client baseline')
  self.assertNotEqual(b['revision'],a['revision'])
  self.assertIsNotNone(b['projection'])
  self.assertNotEqual(a['projection']['sessions'][0]['activities'],b['projection']['sessions'][0]['activities'])
  self.assertLessEqual(len(b['revision']),120)
 def test_restart_epoch_returns_fresh_baseline(self):
  a=self.o.state(P1);b=Observer(self.t,cache_secs=0).state(P1,after=a['revision']);self.assertFalse(b['unchanged']);self.assertIsNotNone(b['projection'])
 def test_latest_window_replaced_not_appended(self):
  a=self.o.state(P1,S1);self.f.change=2;b=self.o.state(P1,S1);self.assertEqual(len(b['projection']['sessions'][0]['activities']),1)
  self.assertNotEqual(a['projection']['sessions'][0]['activities'][0]['started_at'],b['projection']['sessions'][0]['activities'][0]['started_at'])
 def test_truncated_sessions_and_exact_old_lookup(self):
  self.f.expanded=True;x=self.o.state(P1,OLD);self.assertTrue(x['coverage']['sessions']['truncated']);self.assertEqual(x['coverage']['sessions']['exact_lookup_extra'],1)
  self.assertEqual([v['id'] for v in x['projection']['sessions']],[S1,OLD]);self.assertFalse(any('offset' in r['body'] or 'cursor' in r['body'] for r in self.f.requests))
 def test_project_filter_narrows_server_query(self):
  x=self.o.state(query='Beta');self.assertEqual([p['id'] for p in x['projection']['projects']],[P2])
 def test_unknown_project_no_details_dispatched(self):
  x=self.o.state('outside');self.assertEqual(x['state'],'not_found');self.assertIsNone(x['projection']);self.assertEqual(len(self.f.requests),2)
 def test_wrong_detail_identity_rejected(self):
  self.f.detail_id=S2;x=self.o.state(P1,S1);self.assertEqual(x['state'],'upstream_invalid');self.assertIsNone(x['projection'])
 def test_cross_project_job_cannot_bind(self):
  self.f.overrides['/api/jobs/list']=(200,{'success':True,'output':{'jobs':[{'job_id':'bad','project':P2,'status':'running'}],'matched_count':1,'truncated':False}}, {})
  self.assertEqual(self.o.state(P1)['state'],'upstream_invalid')
 def test_detached_job_owner_preserved_not_falsely_bound(self):
  self.f.overrides['/api/jobs/list']=(200,{'success':True,'output':{'jobs':[{'job_id':'detached','project':P1,'session_id':OLD,'status':'running'}],'matched_count':1,'truncated':False}}, {})
  j=self.o.state(P1)['projection']['jobs'][0];self.assertIsNone(j['session_id']);self.assertEqual(j['owner_session_id'],OLD)
 def test_duplicate_projects_rejected(self):
  row={'id':P1,'name':'a','path':'/a'};self.f.overrides['/api/runtime-console/projects']=(200,{'projects':[row,row],'total':2,'truncated':False},{})
  self.assertEqual(self.o.state()['state'],'upstream_invalid')
 def test_malformed_nested_status_rejected_safely(self):
  self.f.overrides['/api/runtime/status']=(200,{'success':True,'output':{'service':'webcodex','version':'0.4.1','focus':[]}},{})
  # Empty optional focus is valid unknown; nonempty wrong type must fail.
  self.f.overrides['/api/runtime/status'][1]['output']['focus']=['bad']
  self.assertEqual(self.o.state()['state'],'upstream_invalid')
 def test_version_change_no_guess(self):
  self.f.overrides['/api/runtime/status']=(200,{'success':True,'output':{'service':'webcodex','version':'9.0'}},{})
  self.assertEqual(self.o.state()['state'],'incompatible_version');self.assertEqual(len(self.f.requests),1)
 def test_auth_rejection_clears_every_cached_view_and_stops_reads(self):
  self.o.state(P1);self.o.state(P2);self.f.overrides['/api/runtime/status']=(401,{'secret':TOKEN},{})
  x=self.o.state(P1);self.assertEqual(x['state'],'auth_required');n=len(self.f.requests)
  y=self.o.state(P2);self.assertEqual(len(self.f.requests),n);self.assertIsNone(y['projection']);self.assertNotIn(TOKEN,json.dumps(x))
 def test_access_denied_drops_view(self):
  self.o.state(P1);self.f.overrides['/api/runtime-console/workflow-sessions']=(403,{'error':TOKEN},{})
  x=self.o.state(P1);self.assertEqual(x['state'],'access_denied');self.assertIsNone(x['projection']);self.assertNotIn(TOKEN,json.dumps(x))
 def test_not_found_drops_stale_session(self):
  self.o.state(P1,S1);self.f.overrides['/api/runtime-console/workflow-session']=(404,{},{});self.assertIsNone(self.o.state(P1,S1)['projection'])
 def test_temporary_503_retains_stale_and_only_three_retries(self):
  self.o.state(P1);before=len(self.f.requests);self.f.overrides['/api/runtime/status']=(503,{}, {})
  x=self.o.state(P1);self.assertEqual(x['state'],'stale');self.assertIsNotNone(x['projection']);self.assertEqual(len(self.f.requests)-before,3)
  self.f.overrides.clear();self.force();self.assertEqual(self.o.state(P1)['state'],'connected')
 def test_repeated_failures_backoff(self):
  self.f.overrides['/api/runtime/status']=(503,{},{});self.o.state();self.force();x=self.o.state();self.assertGreaterEqual(x['refresh_after_ms'],9000)
 def test_429_honors_wait_without_immediate_retry(self):
  self.f.overrides['/api/runtime/status']=(429,{}, {'Retry-After':'120'})
  x=self.o.state();self.assertEqual(x['state'],'rate_limited');self.assertGreaterEqual(x['refresh_after_ms'],119000);self.assertEqual(len(self.f.requests),1)
 def test_redirect_never_forwards_credential(self):
  self.f.overrides['/api/runtime/status']=(302,{}, {'Location':self.f.origin+'/escape'})
  self.assertEqual(self.o.state()['state'],'redirect_rejected');self.assertEqual(len(self.f.requests),1)
 def test_malformed_body_and_oversize_are_safe(self):
  for data in [b'not-json',b' '* (MAX_BODY+1)]:
   self.f.overrides['/api/runtime/status']=(200,data,{});self.force();x=self.o.state();self.assertEqual(x['state'],'upstream_invalid')
 def test_does_not_accept_html_or_compression(self):
  for headers in [{'Content-Type':'text/html'},{'Content-Encoding':'gzip'}]:
   self.f.overrides['/api/runtime/status']=(200,{},headers.copy());self.force();self.assertEqual(self.o.state()['state'],'upstream_invalid')
 def test_protocol_error_does_not_serve_previous_data(self):
  self.o.state();self.f.overrides['/api/runtime/status']=(200,b'{bad',{});self.assertIsNone(self.o.state()['projection'])
 def test_secret_patterns_redacted_from_projection(self):
  d={**session(),'activity':[dict(activity(),summary=TOKEN)],'activity_total':1,'activity_returned':1,'activity_truncated':False}
  self.f.overrides['/api/runtime-console/workflow-session']=(200,d,{})
  self.assertNotIn(TOKEN,json.dumps(self.o.state(P1,S1)))
 def test_same_view_singleflight_and_cache(self):
  self.o.cache_secs=2;self.f.delay=.03
  with ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(lambda _:self.o.state(P1),range(6)))
  self.assertEqual(len(self.f.requests),4);self.assertTrue(any(x['state']=='connected' for x in results));self.o.state(P1);self.assertEqual(len(self.f.requests),4)
 def test_default_refresh_interval_uses_milliseconds_once(self):
  x=Observer(self.t).state(P1)
  self.assertGreaterEqual(x['refresh_after_ms'],1000)
  self.assertLessEqual(x['refresh_after_ms'],5000)
 def test_redirect_after_success_is_terminal_not_stale(self):
  self.o.state(P1);before=len(self.f.requests)
  self.f.overrides['/api/runtime/status']=(302,{}, {'Location':self.f.origin+'/escape'})
  x=self.o.state(P1)
  self.assertEqual(x['state'],'redirect_rejected');self.assertIsNone(x['projection'])
  self.assertEqual(len(self.f.requests)-before,1)
 def test_mutation_operation_is_not_in_transport(self):
  with self.assertRaises(ObservationError):self.t.post('run',{},time.monotonic()+1)
  self.assertEqual(self.f.requests,[])
 def test_unconfigured_has_no_fake_projection(self):
  x=Observer(None).state();self.assertEqual(x['state'],'not_configured');self.assertIsNone(x['projection'])

class NativeJobRouteTests(unittest.TestCase):
 def setUp(self):
  self.f=Fixture();self.t=Transport(self.f.origin,TOKEN,timeout=.5);self.o=Observer(self.t,cache_secs=0)
 def tearDown(self):self.f.close()
 def pinned(self,commit='37098d4624f0',dirty=False,nested=False):
  build={'git_commit':commit,'git_dirty':dirty};status={'service':'webcodex','version':'0.4.1'}
  status.update({'server':{'build':build}} if nested else {'build':build})
  self.f.overrides['/api/runtime/status']=(200,{'success':True,'output':status},{})
  self.f.overrides['/api/jobs/list']=(404,{}, {})
  def jobs(body):
   if body.get('tool')!='list_jobs':return 400,{},{}
   return 200,self.f.body('/api/jobs/list',body['params']),{}
  self.f.overrides['/api/tools/call']=jobs
 def test_pinned_read_only_native_job_route_preserves_projection(self):
  self.pinned();result=self.o.state(P1,S1);self.assertEqual(result['state'],'connected')
  calls=[r for r in self.f.requests if r['path']=='/api/tools/call'];self.assertEqual(len(calls),1)
  self.assertEqual(calls[0]['body'],{'tool':'list_jobs','params':{'project':P1,'limit':100}})
  self.assertFalse(any(r['path']=='/api/jobs/list' for r in self.f.requests));self.assertFalse(self.o.info()['automatic_actions'])
 def test_nested_identity_matches_actual_client_focused_status(self):
  self.pinned(nested=True);self.assertEqual(self.o.state(P1,S1)['state'],'connected')
 def test_full_pinned_sha_selects_same_read_contract(self):
  self.pinned(commit='37098d4624f0000bfab54ad102ecb0df619d7dc6');self.assertEqual(self.o.state(P1,S1)['state'],'connected')
 def test_clean_liveness_build_uses_existing_job_wire_without_404_fallback(self):
  for commit in ('9ae45a2a0ad7','9ae45a2a0ad7e0de170d35075cc7ff12c4b64d98'):
   with self.subTest(commit=commit):
    self.f.requests.clear();self.pinned(commit);result=self.o.state(P1,S1)
    self.assertEqual(result['state'],'connected')
    calls=[r for r in self.f.requests if r['path']=='/api/tools/call']
    self.assertEqual([r['body'] for r in calls],[{'tool':'list_jobs','params':{'project':P1,'limit':100}}])
    self.assertFalse(any(r['path']=='/api/jobs/list' for r in self.f.requests))
 def test_unknown_build_or_dirty_build_never_selects_new_gateway(self):
  for commit,dirty in [('unreviewed',False),('37098d4624f0',True),('9ae45a2a0ad7',True)]:
   self.f.requests.clear();self.pinned(commit,dirty);t=Transport(self.f.origin,TOKEN);result=Observer(t).state(P1,S1)
   self.assertEqual(result['state'],'not_found');self.assertFalse(any(r['path']=='/api/tools/call' for r in self.f.requests))
 def test_404_never_triggers_an_alternate_route(self):
  self.pinned();self.f.overrides['/api/tools/call']=(404,{},{});result=self.o.state(P1,S1)
  self.assertEqual(result['state'],'not_found');self.assertEqual(sum(r['path']=='/api/tools/call' for r in self.f.requests),1)
  self.assertFalse(any(r['path']=='/api/jobs/list' for r in self.f.requests))
 def test_new_read_route_never_opens_arbitrary_mutations(self):
  self.pinned();self.t.post('status',{'compact':True},time.monotonic()+2)
  with self.assertRaises(ObservationError):self.t.post('run_process',{},time.monotonic()+2)
  self.assertEqual(len(self.f.requests),1)
 def test_observed_rollback_reselects_original_read_route(self):
  self.pinned();self.assertEqual(self.o.state(P1,S1)['state'],'connected')
  del self.f.overrides['/api/runtime/status'];del self.f.overrides['/api/jobs/list'];self.f.requests.clear()
  self.assertEqual(self.o.state(P1,S1)['state'],'connected');self.assertTrue(any(r['path']=='/api/jobs/list' for r in self.f.requests))
  self.assertFalse(any(r['path']=='/api/tools/call' for r in self.f.requests))

class ProxyTests(unittest.TestCase):
 def setUp(self):
  self.f=Fixture();self.o=Observer(Transport(self.f.origin,TOKEN),cache_secs=2);self.server=create_server(0,self.o);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}'
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.f.close()
 def test_live_response_has_no_credentials(self):
  with urlopen(self.url+'/api/live/state',timeout=4) as f:body=f.read().decode();self.assertNotIn(TOKEN,body);self.assertEqual(json.loads(body)['state'],'connected')
 def test_unknown_duplicate_or_arbitrary_proxy_query_rejected(self):
  for query in ['url=http://example.com','project=a&project=b','after=a&token=b']:
   with self.assertRaises(HTTPError) as e:urlopen(self.url+'/api/live/state?'+query,timeout=3)
   self.assertEqual(e.exception.code,400)
  self.assertEqual(self.f.requests,[])
 def test_secret_files_not_served(self):
  for path in ['/.local/control-center/connection.json','/config/connection.example.json','/scripts/live_transport.py']:
   with self.assertRaises(HTTPError) as e:urlopen(self.url+path,timeout=3)
   self.assertEqual(e.exception.code,404)
 def test_write_to_live_endpoint_not_allowed(self):
  with self.assertRaises(HTTPError) as e:urlopen(Request(self.url+'/api/live/state',data=b'{}',method='POST'))
  self.assertEqual(e.exception.code,405);self.assertEqual(self.f.requests,[])
 def test_wrong_origin_never_hits_upstream(self):
  with self.assertRaises(HTTPError) as e:urlopen(Request(self.url+'/api/live/state',headers={'Origin':'https://foreign.invalid'}))
  self.assertEqual(e.exception.code,403);self.assertEqual(self.f.requests,[])

if __name__=='__main__':unittest.main(verbosity=2)
