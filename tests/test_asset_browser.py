"""Real isolated Edge exercises asset creation, true image upload, review and ZIP download."""
from pathlib import Path
from io import BytesIO
import hashlib,json,os,sys,tempfile,threading,unittest,uuid,zipfile
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from playwright.sync_api import sync_playwright
from asset_store import AssetStore
from test_assets import sample,raster
from serve_control_center import create_server
OUT=Path(os.environ.get('CLW_ASSET_EVIDENCE_DIR',str(ROOT/'evidence/WB002-5/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-5').resolve()):raise ValueError('Evidence must stay in WB002-5')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.s=AssetStore(Path(self.tmp.name)/'assets.sqlite3');self.server=create_server(asset_store=self.s);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_address[1])+'/'
        self.ctx=self.browser.new_context(viewport={'width':1480,'height':1080});self.p=self.ctx.new_page();self.errors=[];self.requests=[];self.posts=[];self.p.on('pageerror',lambda e:self.errors.append(str(e)));self.p.on('request',lambda r:(self.requests.append(r.url),self.posts.append(r.url) if r.method=='POST' else None));self.goto()
    def tearDown(self):
        try:self.assertEqual(self.errors,[]);self.assertTrue(all(u.startswith(self.url) or u.startswith('blob:') for u in self.requests))
        finally:self.ctx.close();self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def goto(self):self.p.goto(self.url+'assets.html');self.p.wait_for_function("() => document.querySelector('#assetServiceState').textContent.includes('本机素材库已连接')")
    def cmd(self,action,b=None,data=None):
        r={'request_id':str(uuid.uuid4()),'actor':'browser test','action':action,'data':data or {}}
        if b:r.update(batch_id=b['id'],expected_version=b['version'])
        return self.s.command(r)['batch']
    def seed(self,api=False,complete=False):
        b=self.cmd('create',data={'contract':sample(api)});b=self.cmd('publish',b,{'confirmed':True});b=self.cmd('reserve',b,{'asset_keys':['icon']})
        if complete:b=self.cmd('outcome',b,{'attempt_id':b['attempts'][0]['id'],'state':'completed','external_ref':'test-original','evidence':'test external result','confirmed':True,'charge':{'status':'unknown' if api else 'not_applicable','amount':None}})
        self.refresh();self.p.wait_for_function("() => document.querySelectorAll('.asset-attempt').length===1");return b
    def refresh(self):self.p.locator('#refreshAssets').click();self.p.wait_for_function("() => document.querySelector('#assetBatchTitle')!==null")
    def confirm(self):self.p.locator('#assetConsent').check();self.p.locator('#assetActionGo').click();self.p.wait_for_function("() => !document.querySelector('#assetAction').open")
    def open_upload(self,data=None):
        self.p.get_by_role('button',name='导入候选图片',exact=True).click();self.p.locator('#assetInputFile').set_input_files({'name':'候选.png','mimeType':'image/png','buffer':data or raster()})
    def upload(self,data=None):self.open_upload(data);self.confirm();self.p.wait_for_function("() => document.querySelectorAll('.asset-candidate').length>0")
    def approve(self):self.p.get_by_role('button',name='批准',exact=True).first.click();self.p.locator('#assetEvidence').fill('实际查看测试图，测试夹具许可已核对');self.confirm();self.p.wait_for_function("() => document.querySelector('#exportAssetDelivery')?.disabled === false")
    def test_empty_page_never_writes_or_calls_provider(self):self.assertEqual(self.s.listing()['batches'],[]);self.assertEqual(self.posts,[])
    def test_complete_ui_workflow_and_actual_zip(self):
        self.p.locator('#newAssetBatch').click()
        for id,text in [('assetTitle','完整界面验收'),('assetProject','agent:test:project'),('assetRoot','D:/sandbox/project')]:self.p.locator('#'+id).fill(text)
        row=self.p.locator('.asset-spec-row');row.locator('[data-key=key]').fill('icon');row.locator('[data-key=prompt]').fill('此处为测试需求，不调用模型');row.locator('[data-key=width]').fill('64');row.locator('[data-key=height]').fill('64');row.locator('[data-key=transparency]').select_option('required')
        self.p.locator('#saveAssetBatch').click();self.p.wait_for_function("() => !document.querySelector('#assetEditor').open && document.querySelector('#publishAssetBatch')!==null");self.p.locator('#publishAssetBatch').click();self.confirm();self.p.wait_for_function("() => document.querySelector('#reserveAssetItems')!==null")
        self.p.locator('[data-select-key=icon]').check();self.p.locator('#reserveAssetItems').click();self.confirm();self.p.wait_for_function("() => document.querySelectorAll('.asset-attempt').length===1")
        self.p.get_by_role('button',name='记录 / 核对原结果',exact=True).click();self.p.locator('#assetOutcome').select_option('completed');self.p.locator('#assetExternalRef').fill('same-local-original');self.p.locator('#assetEvidence').fill('在外部已完成的夹具结果');self.confirm();self.p.wait_for_function("() => document.querySelector('#assetDetail').textContent.includes('外部完成')")
        self.upload();self.approve()
        with self.p.expect_download() as d:self.p.locator('#exportAssetDelivery').click()
        with zipfile.ZipFile(d.value.path()) as z:
            m=json.loads(z.read('manifest.json'));self.assertEqual(hashlib.sha256(z.read('candidates/icon.png')).hexdigest(),m['selected_candidates'][0]['sha256']);self.assertIn('not_performed',m['integration'])
    def test_frozen_handoff_download_has_original_attempt(self):
        b=self.seed()
        with self.p.expect_download() as d:self.p.locator('#exportAssetMarkdown').click()
        text=Path(d.value.path()).read_text(encoding='utf-8');self.assertIn(b['attempts'][0]['id'],text);self.assertIn(b['spec_hash'],text);self.assertEqual(self.posts,[])
    def test_unknown_bill_remains_unknown_and_blocks_reclaim(self):
        self.seed(True,True);self.p.wait_for_function("() => document.querySelector('#assetAccounting').textContent.includes('未知费用 1')");self.assertTrue(self.p.locator('#reserveAssetItems').is_disabled());self.assertTrue(self.p.locator('#exportAssetDelivery').is_disabled())
    def test_wrong_dimensions_cannot_approve(self):
        self.seed(complete=True);self.upload(raster(32));self.assertTrue(self.p.get_by_role('button',name='批准',exact=True).is_disabled());self.assertIn('width不符合',self.p.locator('.asset-candidate').inner_text())
    def test_lost_upload_reply_recovers_without_second_image(self):
        b=self.seed(complete=True);self.open_upload()
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/assets/upload',lose);self.p.locator('#assetConsent').check();self.p.locator('#assetActionGo').click();self.p.wait_for_function("() => document.querySelector('#assetActionError').textContent.includes('结果未知')");self.assertEqual(len(self.s.get(b['id'])['candidates']),1)
        self.p.unroute('**/api/assets/upload',lose);self.goto();self.p.locator('#recoverAsset').click();self.p.wait_for_function("() => document.querySelector('#assetPending').hidden");self.assertEqual(len(self.s.get(b['id'])['candidates']),1)
    def test_unknown_upload_blocks_new_editor_even_after_close(self):
        self.seed(complete=True);self.open_upload();held=[];self.p.route('**/api/assets/upload',lambda route:held.append(route));self.p.locator('#assetConsent').check();self.p.locator('#assetActionGo').click();self.p.wait_for_timeout(100);self.p.locator('#closeAssetAction').click()
        try:self.assertTrue(self.p.locator('#newAssetBatch').is_disabled())
        finally:
            for route in held:route.continue_()
            self.p.unroute('**/api/assets/upload')
            self.p.wait_for_timeout(200)
    def test_lost_metadata_reply_recovers_original_batch(self):
        self.p.locator('#newAssetBatch').click();self.p.locator('#assetTitle').fill('一次保存');self.p.locator('#assetProject').fill('agent:test:project');self.p.locator('#assetRoot').fill('D:/sandbox/project');self.p.locator('[data-key=prompt]').fill('测试')
        def lose(route):route.fetch();route.abort()
        self.p.route('**/api/assets/command',lose);self.p.locator('#saveAssetBatch').click();self.p.wait_for_function("() => document.querySelector('#assetEditorError').textContent.includes('结果未知')");self.p.unroute('**/api/assets/command',lose);self.goto();self.p.locator('#recoverAsset').click();self.p.wait_for_function("() => document.querySelector('#assetPending').hidden");self.assertEqual(len(self.s.listing()['batches']),1)
    def test_stale_draft_conflict_retains_user_text(self):
        b=self.cmd('create',data={'contract':sample()});self.refresh();self.p.locator('#editAssetDraft').click();self.p.locator('#assetTitle').fill('本窗口草稿');c=sample();c['title']='其他窗口';self.cmd('update',b,{'contract':c});self.p.locator('#saveAssetBatch').click();self.p.wait_for_function("() => document.querySelector('#assetEditorError').textContent.length>0");self.assertEqual(self.p.locator('#assetTitle').input_value(),'本窗口草稿');self.assertTrue(self.p.locator('#assetEditor').evaluate('(d)=>d.open'))
    def test_switching_batches_clears_old_candidates_immediately(self):
        self.seed(complete=True);self.upload();other=sample();other['title']='另一个批次';b=self.cmd('create',data={'contract':other});self.refresh();self.p.wait_for_function("() => document.querySelectorAll('.asset-batch').length===2");held=[];pattern='**/api/assets/get?id='+b['id'];self.p.route(pattern,lambda route:held.append(route));self.p.locator('[data-batch-id="'+b['id']+'"]').click();self.p.wait_for_timeout(100)
        try:self.assertEqual(self.p.locator('.asset-candidate').count(),0);self.assertEqual(self.p.locator('#exportAssetDelivery').count(),0)
        finally:
            for route in held:route.continue_()
            self.p.unroute(pattern)
    def test_import_only_loads_draft_not_execution(self):
        c=sample();raw={'contract':c,'attempts':[{'state':'completed'}],'selected':{'icon':'fake'}};self.p.locator('#importAssetSpec').set_input_files({'name':'request.json','mimeType':'application/json','buffer':json.dumps(raw).encode()});self.p.wait_for_function("() => document.querySelector('#assetEditor').open");self.assertEqual(self.s.listing()['batches'],[]);self.assertEqual(self.posts,[]);self.p.locator('#saveAssetBatch').click();self.p.wait_for_function("() => !document.querySelector('#assetEditor').open");b=self.s.get(self.s.listing()['batches'][0]['id']);self.assertEqual(b['selected'],{});self.assertEqual(b['status'],'draft')
    def test_raster_preview_and_wide_narrow_screenshots(self):
        self.seed(complete=True);self.upload(raster(metadata=True));self.p.wait_for_function("() => [...document.querySelectorAll('.asset-candidate img')].every(i=>i.complete&&i.naturalWidth===64)")
        for width in (1480,390):
            self.p.set_viewport_size({'width':width,'height':1100});self.p.locator('.asset-candidate details').evaluate('(d)=>d.open=true');self.assertTrue(self.p.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));self.p.screenshot(path=str(OUT/f'assets-{width}.png'),full_page=True)
        self.p.locator('.asset-candidate img').click();self.p.wait_for_function("() => document.querySelector('#assetZoomImage').naturalWidth===64");self.assertTrue(self.p.locator('#assetZoom').evaluate('(d)=>d.open'));self.p.locator('#closeAssetZoom').click()
    def test_markup_remains_text(self):
        c=sample();c['title']='<img src=x onerror=alert(1)>';c['items'][0]['prompt']='<script>attack()</script>';self.cmd('create',data={'contract':c});self.refresh();self.assertEqual(self.p.locator('#assetBatchTitle img').count(),0);self.assertIn('<img',self.p.locator('#assetBatchTitle').inner_text())
    def test_reject_selected_candidate_removes_delivery_readiness(self):
        self.seed(complete=True);self.upload();self.approve();self.p.get_by_role('button',name='退回修改',exact=True).click();self.p.locator('#assetEvidence').fill('边缘需要修改');self.confirm();self.p.wait_for_function("() => document.querySelector('#exportAssetDelivery')?.disabled === true");self.assertEqual(self.s.get(self.s.listing()['batches'][0]['id'])['selected'],{})
    def test_visible_refresh_does_not_replace_open_editor(self):
        b=self.cmd('create',data={'contract':sample()});self.refresh();self.p.locator('#editAssetDraft').click();self.p.locator('#assetTitle').fill('保留输入');self.p.evaluate("() => document.querySelector('#refreshAssets').click()");self.p.wait_for_timeout(200);self.assertEqual(self.p.locator('#assetTitle').input_value(),'保留输入');self.assertTrue(self.p.locator('#assetEditor').evaluate('(d)=>d.open'))

    def test_partial_multifile_upload_keeps_confirmed_and_reselects_remaining(self):
        b=self.seed(complete=True);self.open_upload();self.p.locator('#assetInputFile').set_input_files([{'name':'good.png','mimeType':'image/png','buffer':raster()},{'name':'bad.png','mimeType':'image/png','buffer':b'not a picture'}]);self.p.locator('#assetConsent').check();self.p.locator('#assetActionGo').click();self.p.wait_for_function("() => document.querySelector('#assetActionError').textContent.includes('图片无法')")
        self.assertEqual(len(self.s.get(b['id'])['candidates']),1);self.assertEqual(self.p.locator('#assetInputFile').input_value(),'')
        self.p.locator('#assetInputFile').set_input_files({'name':'fixed.png','mimeType':'image/png','buffer':raster(metadata=True)});self.confirm();self.p.wait_for_function("() => document.querySelectorAll('.asset-candidate').length===2");self.assertEqual(len(self.s.get(b['id'])['candidates']),2)

    def test_return_stops_remaining_files_without_canceling_accepted_upload(self):
        b=self.seed(complete=True);self.open_upload();self.p.locator('#assetInputFile').set_input_files([{'name':'one.png','mimeType':'image/png','buffer':raster()},{'name':'two.png','mimeType':'image/png','buffer':raster(metadata=True)}])
        held=[]
        def first_only(route):
            if not held:held.append(route)
            else:route.continue_()
        self.p.route('**/api/assets/upload',first_only);self.p.locator('#assetConsent').check();self.p.locator('#assetActionGo').click()
        self.p.wait_for_timeout(200);self.assertEqual(len(held),1);self.p.locator('#closeAssetAction').click();held[0].continue_()
        self.p.wait_for_function("() => !document.querySelector('#newAssetBatch').disabled");self.p.wait_for_timeout(150)
        self.assertEqual(len(self.s.get(b['id'])['candidates']),1)
        self.assertEqual(sum(u.endswith('/api/assets/upload') for u in self.posts),1)
        self.assertIn('停止后续',self.p.locator('#assetNotice').inner_text())
        self.p.unroute('**/api/assets/upload',first_only)

if __name__=='__main__':unittest.main(verbosity=2)
