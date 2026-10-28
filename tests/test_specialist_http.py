from pathlib import Path
import json,sys,tempfile,threading,unittest,uuid
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_store import TaskStore
from usage_store import UsageStore
from specialist_service import Specialists
from specialist_fixture import FakeNative
from test_task_store import Observe,example
from test_usage_store import sample
from serve_control_center import create_server
class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.tasks=TaskStore(Path(self.tmp.name)/'tasks.sqlite3',Observe());self.usage=UsageStore(Path(self.tmp.name)/'usage.sqlite3');self.bridge=FakeNative();self.bridge.enabled=False
        self.server=create_server(0,task_store=self.tasks,specialists=Specialists(self.tasks,self.bridge),usage_store=self.usage);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}'
        with urlopen(self.url+'/api/usage/info') as r:self.info=json.load(r)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def req(self,path='/api/usage/command',method='POST',body=None,headers=None):
        data=json.dumps(body or {'request_id':str(uuid.uuid4()),'action':'record','actor':'test','data':sample()}).encode() if method=='POST' else None
        h={'Content-Type':'application/json','Origin':self.url,'X-CLW-Intent':self.info['intent']};h.update(headers or {});h={k:v for k,v in h.items() if v is not None}
        with urlopen(Request(self.url+path,data=data,method=method,headers=h),timeout=5) as r:return json.load(r)
    def denied(self,status,**kw):
        with self.assertRaises(HTTPError) as e:self.req(**kw)
        self.assertEqual(e.exception.code,status);self.assertEqual(self.usage.listing()['entries'],[]);self.assertEqual(self.bridge.calls,[])
    def test_default_info_no_dispatch(self):self.assertFalse(self.req('/api/specialists/info','GET')['dispatch_enabled'])
    def test_actual_record_and_durable_receipt(self):
        r=self.req();self.assertEqual(r['entry']['amount'],'0.10');s=self.req('/api/usage/receipt?request_id='+r['request_id'],'GET');self.assertTrue(s['found'])
    def test_missing_origin_refused(self):self.denied(403,headers={'Origin':None})
    def test_cross_site_refused(self):self.denied(403,headers={'Origin':'https://wrong.invalid'})
    def test_missing_intent_refused(self):self.denied(403,headers={'X-CLW-Intent':None})
    def test_bad_host_refused(self):self.denied(403,headers={'Host':'elsewhere.invalid'})
    def test_cross_site_get_refused(self):self.denied(403,path='/api/specialists/info',method='GET',headers={'Sec-Fetch-Site':'cross-site'})
    def test_duplicate_query_refused(self):self.denied(400,path='/api/usage/list?after=0&after=1',method='GET')
    def test_arbitrary_url_not_proxy(self):self.denied(404,path='/api/specialists/capabilities?url=file:///private',method='GET')
    def test_oversized_body_refused(self):self.denied(413,headers={'Content-Length':'3000000'})
    def test_wrong_content_type(self):self.denied(415,headers={'Content-Type':'text/plain'})
    def test_unimplemented_method(self):self.denied(405,path='/api/usage/command',method='DELETE')
    def test_account_credentials_not_a_route(self):self.denied(404,path='/api/usage/account/read',method='GET')
    def test_static_page_keeps_csp_and_no_secret(self):
        with urlopen(self.url+'/specialists.html') as r:
            self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy']);text=r.read().decode();self.assertIn('三本用量账',text);self.assertNotIn(self.info['intent'],text)
    def test_private_files_not_served(self):self.denied(404,path='/.local/control-center/usage.sqlite3',method='GET')
if __name__=='__main__':unittest.main(verbosity=2)
