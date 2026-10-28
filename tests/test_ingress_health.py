from pathlib import Path
import hashlib,json,sys,tempfile,threading,time,unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from ingress_health import IngressSources,IngressHealth,ProbeError,parse_metrics,origin,http_get,MAX_METRICS
from task_domain import TaskError
from account_fixture import source_entries,metrics,T1,T2

class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.entries=source_entries(self.tmp.name);self.sources=IngressSources(self.entries);self.clock=1789969000.;self.body=metrics(clock=self.clock);self.calls=[]
        def getter(url,path,cap):
            self.calls.append((url,path));return 200,self.body if path=='/metrics' else 'live' if path=='/healthz' else 'ready'
        self.monitor=IngressHealth(self.sources,getter,lambda:self.clock,cache_secs=0)
    def tearDown(self):self.tmp.cleanup()
    def test_fresh_identified_poll_not_just_ready(self):
        r=self.monitor.observe('A');self.assertEqual(r['state'],'polling');self.assertFalse(r['account_authentication']);self.assertIsNone(r['process_pid']);self.assertEqual(r['poll_age_secs'],3)
    def test_ready_without_poll_is_not_connected(self):
        self.body=metrics(clock=self.clock,poll=False);self.assertEqual(self.monitor.observe('A')['state'],'poll_not_seen')
    def test_old_poll_is_explicitly_stale(self):
        self.body=metrics(clock=self.clock-120);self.assertEqual(self.monitor.observe('A')['state'],'poll_stale')
    def test_future_poll_rejected(self):
        self.body=metrics(clock=self.clock+100);self.assertEqual(self.monitor.observe('A')['error_code'],'clock_invalid')
    def test_other_tunnel_never_colored_green(self):
        self.body=metrics(T2,self.clock);self.assertEqual(self.monitor.observe('A')['error_code'],'tunnel_identity_mismatch')
    def test_multiple_tunnel_labels_rejected(self):
        self.body+='x{tunnel_id="'+T2+'"} 1\n';self.assertEqual(self.monitor.observe('A')['error_code'],'tunnel_identity_mismatch')
    def test_unknown_tunnel_identity_stays_unknown(self):
        self.body='\n'.join(l for l in self.body.splitlines() if 'tunnel_id' not in l);self.assertEqual(self.monitor.observe('A')['state'],'identity_unverified')
    def test_missing_process_incarnation_is_not_verified(self):
        self.body='\n'.join(l for l in self.body.splitlines() if not l.startswith('process_start'));self.assertEqual(self.monitor.observe('A')['state'],'identity_unverified')
    def test_duplicate_gauge_rejected(self):
        self.body+='commands_poll_last_successful_timestamp_seconds '+str(self.clock)+'\n';self.assertEqual(self.monitor.observe('A')['error_code'],'ambiguous_metric')
    def test_nonfinite_metrics_rejected(self):
        self.body+='commands_poll_cycles_total NaN\n';self.assertEqual(self.monitor.observe('A')['error_code'],'invalid_metric_value')
    def test_malformed_labels_rejected(self):
        with self.assertRaises(ProbeError):parse_metrics('readiness{wrong} 1',T1,self.clock)
    def test_stale_cache_status_ages_without_network(self):
        self.monitor.cache_secs=300;r=self.monitor.observe('A');self.clock+=100;r=self.monitor.observe('A');self.assertEqual(r['state'],'observation_stale');self.assertEqual(len(self.calls),3)
    def test_changed_ephemeral_port_followed_without_starting_process(self):
        before=self.monitor.observe('A');Path(self.entries[0]['health_url_file']).write_text('http://127.0.0.1:45679');after=self.monitor.observe('A');self.assertNotEqual(before['process_fingerprint'],after['process_fingerprint']);self.assertEqual(self.calls[-1][0],'http://127.0.0.1:45679')
    def test_unavailable_reference_clears_current_good_status(self):
        self.monitor.observe('A');Path(self.entries[0]['health_url_file']).unlink();r=self.monitor.observe('A');self.assertEqual(r['state'],'unavailable');self.assertIsNone(r.get('last_poll_at'))
    def test_reference_change_during_request_is_rejected(self):
        p=Path(self.entries[0]['health_url_file']);old=self.monitor.getter
        def getter(url,path,cap):
            if path=='/metrics':p.write_text('http://127.0.0.1:45670')
            return old(url,path,cap)
        self.monitor.getter=getter;self.assertEqual(self.monitor.observe('A')['error_code'],'health_reference_changed')
    def test_reference_is_not_general_file_reader(self):
        for value in ['file:///tmp/a','http://localhost:80','http://127.0.0.1:80/secret','http://127.0.0.1:80?x','http://user@127.0.0.1:80','http://127.0.0.1:65536','https://example.com']:
            Path(self.entries[0]['health_url_file']).write_text(value);self.assertEqual(self.monitor.observe('A')['state'],'unavailable')
        self.assertEqual(self.calls,[])
    def test_oversized_reference_not_fetched(self):
        Path(self.entries[0]['health_url_file']).write_text('X'*300);self.assertEqual(self.monitor.observe('A')['error_code'],'health_reference_invalid');self.assertEqual(self.calls,[])
    def test_sources_reject_secret_or_duplicate_entries(self):
        with self.assertRaises(TaskError):IngressSources(self.entries+[self.entries[0]])
        with self.assertRaises(TaskError):IngressSources([self.entries[0]|{'api_key':'not-allowed'}])
    def test_sources_do_not_accept_arbitrary_config_files(self):
        with self.assertRaises(TaskError):IngressSources([self.entries[0]|{'health_url_file':str(Path(self.tmp.name)/'runner.toml')}])
    def test_public_sources_omit_health_reference(self):self.assertNotIn('health_url_file',self.sources.public()[0])
    def test_json_source_load_does_not_read_token(self):
        p=Path(self.tmp.name)/'ingresses.json';p.write_text(json.dumps({'schema_version':1,'sources':self.entries}));s=IngressSources.load(p);self.assertEqual(len(s.public()),2)
    def test_source_miss_does_not_probe(self):
        with self.assertRaises(TaskError):self.monitor.observe('unknown')
        self.assertEqual(self.calls,[])
    def test_concurrent_reads_share_one_probe(self):
        self.monitor.cache_secs=5
        with ThreadPoolExecutor(8) as pool:r=list(pool.map(lambda _:self.monitor.observe('A'),range(8)))
        self.assertEqual(len(self.calls),3);self.assertTrue(all(x['state'] in ('polling','checking') for x in r))

class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.requests=[];self.mode='normal';outer=self
        class H(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                outer.requests.append((self.path,self.headers.get('Authorization')))
                if outer.mode=='redirect':self.send_response(302);self.send_header('Location','http://example.invalid/never');self.end_headers();return
                data=(b'X'*(MAX_METRICS+1)) if outer.mode=='large' else b'0123456789' if outer.mode=='slow' else b'live';self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers()
                try:
                    if outer.mode=='slow':
                        for byte in data:self.wfile.write(bytes([byte]));self.wfile.flush();time.sleep(.04)
                    else:self.wfile.write(data)
                except OSError:pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),H);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_address[1])
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def test_direct_loopback_no_authorization(self):self.assertEqual(http_get(self.url,'/healthz'),(200,'live'));self.assertEqual(self.requests,[('/healthz',None)])
    def test_redirect_not_followed(self):
        self.mode='redirect'
        with self.assertRaises(ProbeError):http_get(self.url,'/healthz')
        self.assertEqual(len(self.requests),1)
    def test_only_fixed_read_routes(self):
        with self.assertRaises(ProbeError):http_get(self.url,'/api/start')
        self.assertEqual(self.requests,[])
    def test_oversized_body_rejected(self):
        self.mode='large'
        with self.assertRaises(ProbeError):http_get(self.url,'/metrics')
    def test_trickling_response_has_total_read_deadline(self):
        self.mode='slow';started=time.monotonic()
        with self.assertRaises(ProbeError) as e:http_get(self.url,'/metrics',timeout=.08)
        self.assertEqual(str(e.exception),'health_deadline');self.assertLess(time.monotonic()-started,1)

class RegistrationTests(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        import configure_ingress_profile
        self.module=configure_ingress_profile;self.patch=patch;self.tmp=tempfile.TemporaryDirectory();self.entry=source_entries(self.tmp.name)[0];self.config=Path(self.tmp.name)/'ingresses.json'
    def tearDown(self):self.tmp.cleanup()
    def register(self,**overrides):
        data=self.entry|overrides;argv=['configure','--config',str(self.config)]
        for name in ('id','name','tunnel_id','health_url_file','connection_id'):argv+=['--'+name.replace('_','-'),data[name]]
        with self.patch('sys.argv',argv),self.patch('builtins.print'):return self.module.main()
    def test_registration_and_exact_repeat_do_not_duplicate(self):
        with self.patch.object(self.module.IngressHealth,'observe',return_value={'state':'polling'}):
            self.assertEqual(self.register(),0);before=self.config.read_bytes();self.assertEqual(self.register(),0);self.assertEqual(before,self.config.read_bytes())
    def test_registration_different_source_not_overwritten(self):
        with self.patch.object(self.module.IngressHealth,'observe',return_value={'state':'polling'}):
            self.assertEqual(self.register(),0);before=self.config.read_bytes();self.assertEqual(self.register(name='different'),1);self.assertEqual(before,self.config.read_bytes())
    def test_failed_health_does_not_save_source(self):
        with self.patch.object(self.module.IngressHealth,'observe',return_value={'state':'poll_not_seen'}):self.assertEqual(self.register(),1)
        self.assertFalse(self.config.exists())
    def test_local_registration_lock_prevents_competing_write(self):
        lock=self.config.with_name(self.config.name+'.lock');lock.write_text('another local registration');self.assertEqual(self.register(),1);self.assertTrue(lock.exists());self.assertFalse(self.config.exists())
if __name__=='__main__':unittest.main(verbosity=2)
