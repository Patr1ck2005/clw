"""Real loopback HTTP tests, isolated metadata and bytes only."""
from pathlib import Path
from io import BytesIO
import hashlib,json,sys,tempfile,threading,unittest,uuid,zipfile
from urllib.request import Request,urlopen
from urllib.parse import urlencode,quote
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from asset_store import AssetStore
from asset_domain import MAX_UPLOAD
from test_assets import sample,raster
from serve_control_center import create_server

class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.s=AssetStore(Path(self.tmp.name)/'assets.sqlite3');self.server=create_server(asset_store=self.s);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_address[1]);self.intent=self.server.asset_api.intent
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def req(self,path,method='GET',body=None,headers=None):
        default={'Origin':self.url,'X-CLW-Intent':self.intent,'Content-Type':'application/json'};default.update(headers or {})
        try:r=urlopen(Request(self.url+path,data=body,method=method,headers=default),timeout=6)
        except HTTPError as e:r=e
        with r:return r.status,r.read(),r.headers
    def raw(self,action,b=None,data=None):
        r={'request_id':str(uuid.uuid4()),'actor':'HTTP test','action':action,'data':data or {}}
        if b:r.update(batch_id=b['id'],expected_version=b['version'])
        return r
    def cmd(self,action,b=None,data=None):
        code,body,_=self.req('/api/assets/command','POST',json.dumps(self.raw(action,b,data)).encode());self.assertEqual(code,200,body);return json.loads(body)['batch']
    def ready(self):
        b=self.cmd('publish',self.cmd('create',data={'contract':sample()}),{'confirmed':True});b=self.cmd('reserve',b,{'asset_keys':['icon']});return self.cmd('outcome',b,{'attempt_id':b['attempts'][0]['id'],'state':'completed','external_ref':'local-original','evidence':'test fixture result','charge':{'status':'not_applicable','amount':None},'confirmed':True})
    def upload(self,b,data=None,extra=None):
        data=data or raster();meta={'request_id':str(uuid.uuid4()),'actor':'HTTP test','batch_id':b['id'],'expected_version':b['version'],'attempt_id':b['attempts'][0]['id'],'spec_hash':b['spec_hash'],'source_sha256':hashlib.sha256(data).hexdigest(),'name':'中文候选.png'};meta.update(extra or {})
        return self.req('/api/assets/upload','POST',data,{'Content-Type':'application/octet-stream','X-CLW-Metadata':quote(json.dumps(meta,ensure_ascii=False))})
    def test_info_does_not_dispatch(self):
        code,body,_=self.req('/api/assets/info');r=json.loads(body);self.assertEqual(code,200);self.assertFalse(r['model_calls']);self.assertEqual(self.s.listing()['batches'],[])
    def test_host_and_cross_site_refused(self):
        for headers in [{'Host':'attacker.invalid'},{'Origin':'https://attacker.invalid'},{'Sec-Fetch-Site':'cross-site'}]:self.assertEqual(self.req('/api/assets/info',headers=headers)[0],403)
    def test_post_requires_intent(self):self.assertEqual(self.req('/api/assets/command','POST',b'{}',{'X-CLW-Intent':'wrong'})[0],403)
    def test_unknown_path_and_duplicate_query_refused(self):
        self.assertEqual(self.req('/api/assets/list?after=0&after=1')[0],400);self.assertEqual(self.req('/api/assets/read?path=C:/secret')[0],404)
    def test_put_not_allowed(self):self.assertEqual(self.req('/api/assets/command','PUT',b'{}')[0],405)
    def test_secret_key_not_accepted(self):
        raw=self.raw('create',data={'contract':sample()});raw['data']['contract']['api_key']='x';self.assertEqual(self.req('/api/assets/command','POST',json.dumps(raw).encode())[0],400)
    def test_duplicate_json_keys_rejected(self):self.assertEqual(self.req('/api/assets/command','POST',b'{"action":"create","action":"dispatch"}')[0],400)
    def test_large_length_refused_before_body(self):self.assertEqual(self.req('/api/assets/upload','POST',b'x',{'Content-Type':'application/octet-stream','Content-Length':str(MAX_UPLOAD+1),'X-CLW-Metadata':'{}'})[0],413)
    def test_malformed_upload_metadata(self):self.assertEqual(self.req('/api/assets/upload','POST',b'x',{'Content-Type':'application/octet-stream','X-CLW-Metadata':'%FF'})[0],400)
    def test_no_general_path_upload_or_fetch(self):
        b=self.ready();self.assertEqual(self.upload(b,extra={'path':'D:/secrets.png'})[0],400);self.assertEqual(self.req('/api/assets/image?url=https://outside.invalid')[0],404)
    def test_binary_import_preview_review_and_delivery(self):
        b=self.ready();code,body,headers=self.upload(b);self.assertEqual(code,200,body);r=json.loads(body);b=r['batch'];cid=r['candidate_id']
        code,image,headers=self.req('/api/assets/image?'+urlencode({'id':b['id'],'candidate':cid}));self.assertEqual(code,200);self.assertEqual(headers['Content-Type'],'image/png');self.assertEqual(headers['X-Content-Type-Options'],'nosniff');self.assertEqual(hashlib.sha256(image).hexdigest(),b['candidates'][0]['sha256'])
        b=self.cmd('review',b,{'candidate_id':cid,'outcome':'approved','note':'actual test review','confirmed':True});code,data,headers=self.req('/api/assets/delivery?'+urlencode({'id':b['id']}));self.assertEqual(code,200);self.assertEqual(headers['Content-Type'],'application/zip')
        with zipfile.ZipFile(BytesIO(data)) as z:self.assertEqual(z.read('candidates/icon.png'),image)
    def test_not_ready_delivery_refused(self):b=self.ready();self.assertEqual(self.req('/api/assets/delivery?'+urlencode({'id':b['id']}))[0],409)
    def test_upload_receipt_query_and_replay(self):
        b=self.ready();rid=str(uuid.uuid4());first=self.upload(b,extra={'request_id':rid});second=self.upload(b,extra={'request_id':rid});self.assertEqual(json.loads(first[1])['candidate_id'],json.loads(second[1])['candidate_id']);self.assertTrue(json.loads(second[1])['replayed']);self.assertTrue(json.loads(self.req('/api/assets/receipt?request_id='+rid)[1])['found'])
    def test_invalid_image_is_not_html_response(self):
        b=self.ready();code,body,_=self.upload(b,b'<html><script>alert(1)</script></html>');self.assertEqual(code,400);self.assertEqual(json.loads(body)['error_code'],'invalid_image')
    def test_upload_busy_has_no_write(self):
        b=self.ready();self.server.asset_api.uploads.acquire();self.server.asset_api.uploads.acquire()
        try:self.assertEqual(self.upload(b)[0],429);self.assertEqual(self.s.get(b['id'])['candidates'],[])
        finally:self.server.asset_api.uploads.release();self.server.asset_api.uploads.release()
    def test_static_assets_served(self):
        for path in ['/assets.html','/assets.mjs','/assets.css','/asset-client.mjs']:self.assertEqual(self.req(path)[0],200)
    def test_offline_projects_do_not_change_store(self):self.assertEqual(self.req('/api/assets/projects')[0],409);self.assertEqual(self.s.listing()['batches'],[])
    def test_hash_route_never_accepts_file_path(self):self.assertEqual(self.req('/api/assets/image?id=../../secrets&candidate=../../key')[0],400)

if __name__=='__main__':unittest.main(verbosity=2)
