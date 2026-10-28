from pathlib import Path
import json,sys,tempfile,threading,unittest,uuid
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'tests'))
from task_store import TaskStore
from serve_control_center import create_server
from test_task_store import example

class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=TaskStore(Path(self.tmp.name)/'tasks.sqlite3');self.server=create_server(0,task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}'
        with urlopen(self.url+'/api/tasks/info') as response:self.info=json.load(response)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def request(self,path='/api/tasks/command',method='POST',payload=None,headers=None):
        data=json.dumps(payload or {'request_id':str(uuid.uuid4()),'action':'create','actor':'M','data':{'contract':example()}}).encode() if method!='GET' else None
        h={'Origin':self.url,'Content-Type':'application/json','X-CLW-Intent':self.info['intent']};h.update(headers or {})
        for k in list(h):
            if h[k] is None:del h[k]
        with urlopen(Request(self.url+path,data=data,headers=h,method=method),timeout=5) as r:return r.status,json.load(r)
    def rejected(self,code,**kwargs):
        with self.assertRaises(HTTPError) as error:self.request(**kwargs)
        self.assertEqual(error.exception.code,code);self.assertEqual(self.store.listing()['tasks'],[])
    def test_create_and_read_original_receipt(self):
        status,result=self.request();self.assertEqual(status,200);self.assertEqual(result['effect'],'product_metadata_only')
        _,r=self.request('/api/tasks/receipt?request_id='+result['request_id'],'GET');self.assertTrue(r['found'])
    def test_missing_origin_rejected(self):self.rejected(403,headers={'Origin':None})
    def test_foreign_origin_rejected(self):self.rejected(403,headers={'Origin':'https://other.invalid'})
    def test_wrong_intent_rejected(self):self.rejected(403,headers={'X-CLW-Intent':'wrong'})
    def test_foreign_host_rejected(self):self.rejected(403,headers={'Host':'foreign.invalid'})
    def test_cross_site_info_rejected(self):self.rejected(403,path='/api/tasks/info',method='GET',headers={'Sec-Fetch-Site':'cross-site'})
    def test_wrong_content_type_rejected(self):self.rejected(415,headers={'Content-Type':'text/plain'})
    def test_large_body_rejected(self):self.rejected(413,headers={'Content-Length':str(9000000)})
    def test_unknown_runtime_action_does_not_execute(self):self.rejected(400,payload={'request_id':str(uuid.uuid4()),'action':'run_shell','actor':'M','data':{'command':'never-run'}})
    def test_delete_not_exposed(self):self.rejected(405,method='DELETE')
    def test_duplicate_query_rejected(self):self.rejected(400,path='/api/tasks/get?id=a&id=b',method='GET')
    def test_arbitrary_path_not_proxy(self):self.rejected(404,path='/api/tasks/info?url=file:///anything',method='GET')
    def test_datastore_and_source_files_not_served(self):
        for path in ['/.local/control-center/tasks.sqlite3','/scripts/task_store.py']:
            self.rejected(404,path=path,method='GET')
    def test_task_page_served_and_no_runtime_credentials(self):
        with urlopen(self.url+'/tasks.html') as r:
            text=r.read().decode();self.assertIn('完整任务',text);self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy']);self.assertNotIn(self.info['intent'],text)
if __name__=='__main__':unittest.main(verbosity=2)
