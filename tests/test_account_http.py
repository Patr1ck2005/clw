from pathlib import Path
import json,sys,tempfile,threading,unittest,uuid
import http.client,time
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from account_store import AccountStore
from ingress_health import IngressSources
from account_fixture import source_entries,Observe,Health,P1,S1,CONNECTION
from serve_control_center import create_server

class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.observer=Observe();self.store=AccountStore(Path(self.tmp.name)/'a.sqlite3',IngressSources(source_entries(self.tmp.name)),self.observer,Health())
        self.server=create_server(account_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_address[1]);self.intent=self.get('info')['intent']
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def get(self,path):
        with urlopen(self.url+'/api/accounts/'+path,timeout=5) as r:return json.load(r)
    def post(self,body,headers=None,path='command',method='POST'):
        hs={'Origin':self.url,'X-CLW-Intent':self.intent,'Content-Type':'application/json'};hs.update(headers or {})
        with urlopen(Request(self.url+'/api/accounts/'+path,data=json.dumps(body).encode(),headers=hs,method=method),timeout=5) as r:return json.load(r)
    def raw(self):return {'request_id':str(uuid.uuid4()),'action':'create','actor':'test','data':{'source_id':'A','name':'A','browser_hint':'','notes':''}}
    def test_metadata_create_and_exact_receipt(self):
        raw=self.raw();r=self.post(raw);self.assertEqual(r['effect'],'local_attribution_metadata_only');self.assertEqual(self.get('receipt?request_id='+raw['request_id'])['receipt']['account']['id'],r['account']['id'])
    def test_cross_origin_rejected(self):
        with self.assertRaises(HTTPError) as e:self.post(self.raw(),{'Origin':'https://example.invalid'})
        self.assertEqual(e.exception.code,403)
    def test_bad_intent_rejected(self):
        with self.assertRaises(HTTPError) as e:self.post(self.raw(),{'X-CLW-Intent':'wrong'})
        self.assertEqual(e.exception.code,403)
    def test_bad_host_rejected(self):
        with self.assertRaises(HTTPError) as e:self.post(self.raw(),{'Host':'example.invalid'})
        self.assertEqual(e.exception.code,403)
    def test_cross_site_reads_rejected(self):
        with self.assertRaises(HTTPError) as e:urlopen(Request(self.url+'/api/accounts/list',headers={'Sec-Fetch-Site':'cross-site'}))
        self.assertEqual(e.exception.code,403)
    def test_arbitrary_path_or_url_query_rejected(self):
        for p in ['dashboard?id=x&url=http://example.invalid','list?path=C:/secrets','info?config=other','start','list?x=1&x=2']:
            with self.assertRaises(HTTPError):self.get(p)
    def test_get_cannot_mutate(self):
        with self.assertRaises(HTTPError):self.get('command?action=create')
        self.assertEqual(self.store.listing()['accounts'],[])
    def test_unsupported_methods_rejected(self):
        for method in ['DELETE','PUT','PATCH']:
            with self.assertRaises(HTTPError) as e:self.post(self.raw(),method=method)
            self.assertEqual(e.exception.code,405)
    def test_wrong_content_type_rejected(self):
        with self.assertRaises(HTTPError) as e:self.post(self.raw(),{'Content-Type':'text/plain'})
        self.assertEqual(e.exception.code,415)
    def test_excessive_body_rejected(self):
        with self.assertRaises(HTTPError) as e:self.post({'x':'X'*(2*1024*1024)})
        self.assertEqual(e.exception.code,413)
    def test_oversized_upload_rejection_keeps_socket_result_and_store(self):
        for _ in range(4):
            with self.assertRaises(HTTPError) as error:self.post({'x':'X'*(2*1024*1024)})
            self.assertEqual(error.exception.code,413)
        self.assertEqual(self.store.listing()['accounts'],[])
    def test_declared_huge_body_without_bytes_does_not_hold_handler(self):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=2)
        started=time.monotonic()
        try:
            conn.putrequest('POST','/api/accounts/command')
            for k,v in {'Content-Length':'999999999999','Content-Type':'application/json','Origin':self.url,'X-CLW-Intent':self.intent}.items():conn.putheader(k,v)
            conn.endheaders();response=conn.getresponse();self.assertEqual(response.status,413);response.read()
        finally:conn.close()
        self.assertLess(time.monotonic()-started,2);self.assertEqual(self.store.listing()['accounts'],[])
    def test_no_secret_path_in_list(self):
        raw=json.dumps(self.get('list'));self.assertNotIn('health_url_file',raw);self.assertNotIn(self.tmp.name,raw)
    def test_binding_requires_observation_and_confirmation(self):
        a=self.post(self.raw())['account'];data={'confirmed':True,'project_id':P1,'session_id':S1,'connection_id':CONNECTION,'role':'A','notes':'checked in browser'}
        r=self.post({'request_id':str(uuid.uuid4()),'action':'bind','actor':'test','account_id':a['id'],'expected_version':a['version'],'data':data});self.assertEqual(r['account']['version'],2);self.assertEqual(len(self.get('dashboard?id='+a['id'])['bindings']),1)
    def test_no_authentication_or_process_mutation_capabilities(self):
        info=self.get('info');self.assertFalse(info['account_authentication']);self.assertFalse(info['process_actions']);self.assertFalse(info['runtime_mutations'])
    def test_source_health_is_not_account_sign_in(self):
        a=self.post(self.raw())['account'];d=self.get('dashboard?id='+a['id']);self.assertFalse(d['health']['account_authentication']);self.assertIsNone(d['all_conversation_count'])
if __name__=='__main__':unittest.main(verbosity=2)
