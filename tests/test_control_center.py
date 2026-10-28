"""Read-only preview transport + isolated real browser tests; never contact WebCodex."""
from __future__ import annotations
from pathlib import Path
import importlib.util
import json
import os
from datetime import datetime,timezone
import threading
import unittest
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright, expect
from PIL import Image,ImageStat
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('preview',ROOT/'scripts/serve_control_center.py');preview=importlib.util.module_from_spec(spec);spec.loader.exec_module(preview)
EVIDENCE=Path(os.environ.get('CLW_TEST_EVIDENCE_DIR',str(ROOT/'evidence/WB002-1/browser-runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')))).resolve()
if not any(EVIDENCE.is_relative_to((ROOT/'evidence'/milestone).resolve()) for milestone in ('WB002-1','WB002-2')):
 raise ValueError('Test artifacts must stay inside this product evidence directory')

class ServerTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.server=preview.create_server();cls.port=cls.server.server_address[1];cls.url=f'http://127.0.0.1:{cls.port}';cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
 @classmethod
 def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
 def request(self,path='/',**kwargs):return urlopen(Request(self.url+path,**kwargs),timeout=5)
 def test_allowlisted_snapshot(self):
  with self.request('/data/observed.json') as r:self.assertEqual(len(json.load(r)['projects']),13)
 def test_no_read_of_repo_or_secrets(self):
  for path in ['/.git/config','/../AGENTS.md','/%2e%2e/AGENTS.md','/GENERAL_SETUP.md','/api/run','/data/../app.mjs']:
   with self.assertRaises(HTTPError) as e:self.request(path)
   self.assertEqual(e.exception.code,404)
 def test_foreign_host_rejected(self):
  with self.assertRaises(HTTPError) as e:self.request(headers={'Host':'foreign.example'})
  self.assertEqual(e.exception.code,403)
 def test_cross_origin_rejected(self):
  with self.assertRaises(HTTPError) as e:self.request(headers={'Origin':'https://untrusted.invalid'})
  self.assertEqual(e.exception.code,403)
 def test_cross_site_rejected(self):
  with self.assertRaises(HTTPError) as e:self.request(headers={'Sec-Fetch-Site':'cross-site'})
  self.assertEqual(e.exception.code,403)
 def test_no_write_methods(self):
  for method in ['POST','PUT','PATCH','DELETE']:
   with self.assertRaises(HTTPError) as e:self.request(method=method,data=b'{}')
   self.assertEqual(e.exception.code,405)
 def test_security_headers(self):
  with self.request() as r:
   self.assertEqual(r.headers['Cache-Control'],'no-store');self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy']);self.assertEqual(r.headers['X-Content-Type-Options'],'nosniff')
 def test_only_loopback_binding(self):self.assertEqual(self.server.server_address[0],'127.0.0.1')

class BrowserTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.server=preview.create_server();cls.url=f'http://127.0.0.1:{cls.server.server_address[1]}/';cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start();cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);EVIDENCE.mkdir(parents=True,exist_ok=True)
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.pw.stop();cls.server.shutdown();cls.server.server_close();cls.thread.join()
 def setUp(self):
  self.context=self.browser.new_context(viewport={'width':1480,'height':1100},accept_downloads=True);self.page=self.context.new_page();self.errors=[];self.requests=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.on('request',lambda req:self.requests.append(req.url));self.page.goto(self.url);self.page.wait_for_function("document.querySelector('#projectCount').textContent==='13'")
 def tearDown(self):
  self.assertEqual(self.errors,[]);self.assertTrue(all(x.startswith(self.url) or x.startswith('blob:') for x in self.requests));self.context.close()
 def test_visible_snapshot_and_unknown_identity(self):
  self.assertIn('非实时',self.page.locator('#sourceTitle').inner_text());self.assertEqual(self.page.locator('#sessionCount').inner_text(),'2');self.assertGreater(self.page.get_by_text('账号别名未绑定',exact=True).count(),0)
 def test_filter_project_does_not_touch_backend(self):
  self.page.locator('[data-project-id$="example-game-beta"]').click();self.assertIn('example-game-beta',self.page.locator('#selectedProjectTitle').inner_text());self.assertIn('没有已导入的会话',self.page.locator('#sessionList').inner_text());self.assertEqual(self.page.locator('.session-card').count(),0)
 def test_local_labels_and_reload(self):
  self.page.get_by_role('button',name='标注账号 / 角色').first.click();self.page.locator('#aliasInput').fill('自用账号A');self.page.locator('#roleInput').fill('M');self.page.locator('#bindingForm button[type=submit]').click();self.page.wait_for_function("() => !document.querySelector('#bindingDialog').open");self.page.locator('#accountFilter').select_option(label='自用账号A');self.assertEqual(self.page.locator('.session-card').count(),1);self.page.reload();self.page.wait_for_function("document.querySelector('#projectCount').textContent==='13'");self.assertGreater(self.page.get_by_text('自用账号A',exact=True).count(),0)
 def test_timeline_deduplicates_business_recorder(self):
  self.page.locator('[data-view=timeline]').click();self.assertEqual(self.page.locator('#eventRows tr').count(),2);self.assertIn('6/30',self.page.locator('#timelineSummary').inner_text())
 def test_routing_and_complete_packet_download(self):
  self.page.locator('[data-view=routing]').click();self.page.locator('#taskKind').select_option('deterministic');self.assertIn('普通本机 Job',self.page.locator('#routeAdvice').inner_text());self.page.locator('#goal').fill('中文完整目标\n不要删约束');self.page.locator('#acceptance').fill('必须记录原Job，不重复运行');self.page.locator('#makePacket').click();content=self.page.locator('#packetPreview').input_value();self.assertIn('不要删约束',content);self.assertIn('不是执行或新增授权',content)
  with self.page.expect_download() as info:self.page.locator('#exportPacket').click()
  path=Path(info.value.path());self.assertEqual(path.read_text(encoding='utf-8'),content)
  self.page.locator('#goal').fill('新目标');self.assertTrue(self.page.locator('#exportPacket').is_disabled())
 def test_malformed_import_preserves_current_view(self):
  self.page.locator('#importSnapshot').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{invalid'});self.page.wait_for_function("document.querySelector('#notice').textContent.includes('导入拒绝')");self.assertEqual(self.page.locator('#projectCount').inner_text(),'13')
 def test_untrusted_text_does_not_create_html(self):
  data=json.loads((ROOT/'apps/control-center/data/observed.json').read_text(encoding='utf-8'));data['projects'][0]['name']='<img src=x onerror="window.pwned=true">';self.page.locator('#importSnapshot').set_input_files({'name':'hostile.json','mimeType':'application/json','buffer':json.dumps(data).encode()});self.page.wait_for_function("document.querySelector('#sourceTitle').textContent.includes('用户导入')");self.assertEqual(self.page.locator('#projectList img').count(),0);self.assertFalse(self.page.evaluate('Boolean(window.pwned)'))
 def test_unknown_binding_import_rejected(self):
  self.page.locator('[data-view=help]').click();self.page.get_by_text('标注怎么保存和迁移？',exact=True).click();data={'schema_version':1,'runtime_id':'foreign','bindings':[],'groups':[]};self.page.locator('#importAnnotations').set_input_files({'name':'wrong.json','mimeType':'application/json','buffer':json.dumps(data).encode()});self.page.wait_for_function("document.querySelector('#notice').textContent.includes('标注导入拒绝')")
 def test_multi_tab_distinct_labels_merge(self):
  other=self.context.new_page();other.goto(self.url);other.wait_for_function("document.querySelector('#projectCount').textContent==='13'")
  self.page.get_by_role('button',name='标注账号 / 角色').nth(0).click();other.get_by_role('button',name='标注账号 / 角色').nth(1).click()
  self.page.locator('#aliasInput').fill('窗口甲');other.locator('#aliasInput').fill('窗口乙')
  self.page.locator('#bindingForm button[type=submit]').click();other.locator('#bindingForm button[type=submit]').click()
  self.page.wait_for_function("() => JSON.parse(localStorage.getItem('clw.control-center.v1.example-runtime'))?.bindings.length===2")
  labels=self.page.evaluate("() => JSON.parse(localStorage.getItem('clw.control-center.v1.example-runtime')).bindings.map(b=>b.account_alias).sort()")
  self.assertEqual(labels,['窗口乙','窗口甲'])
 def test_same_item_conflict_keeps_draft(self):
  other=self.context.new_page();other.goto(self.url);other.wait_for_function("document.querySelector('#projectCount').textContent==='13'")
  self.page.get_by_role('button',name='标注账号 / 角色').first.click();other.get_by_role('button',name='标注账号 / 角色').first.click()
  self.page.locator('#aliasInput').fill('先保存');other.locator('#aliasInput').fill('后写草稿')
  self.page.locator('#bindingForm button[type=submit]').click();self.page.wait_for_function("() => document.querySelector('#bindingDialog').open===false")
  other.locator('#bindingForm button[type=submit]').click();other.wait_for_function("() => document.querySelector('#bindingError').textContent.includes('其他窗口')")
  self.assertEqual(other.locator('#aliasInput').input_value(),'后写草稿')
  self.assertEqual(other.evaluate("() => JSON.parse(localStorage.getItem('clw.control-center.v1.example-runtime')).bindings[0].account_alias"),'先保存')
 def test_project_group_changes_navigation_only(self):
  project_id='agent:example-runner:example-game-beta'
  self.page.locator('[data-project-id$="example-game-beta"]').click();self.page.locator('#editGroup').click();self.page.locator('#groupInput').fill('我的游戏合集');self.page.locator('#groupForm button[type=submit]').click()
  self.page.wait_for_function("() => document.querySelector('#groupDialog').open===false")
  self.assertEqual(self.page.locator('.group-label',has_text='我的游戏合集').count(),1)
  self.assertEqual(self.page.locator('[data-project-id$="example-game-beta"]').get_attribute('data-project-id'),project_id)
  self.page.reload();self.page.wait_for_function("document.querySelector('#projectCount').textContent==='13'")
  self.assertEqual(self.page.locator('.group-label',has_text='我的游戏合集').count(),1)
 def test_failed_storage_does_not_claim_saved(self):
  self.page.evaluate("() => {Storage.prototype.setItem=function(){throw new DOMException('test quota','QuotaExceededError')}}")
  self.page.get_by_role('button',name='标注账号 / 角色').first.click();self.page.locator('#aliasInput').fill('必须保留草稿');self.page.locator('#bindingForm button[type=submit]').click()
  self.page.wait_for_function("() => document.querySelector('#bindingError').textContent.length>0")
  self.assertTrue(self.page.locator('#bindingDialog').is_visible());self.assertEqual(self.page.locator('#aliasInput').input_value(),'必须保留草稿')
  self.assertIsNone(self.page.evaluate("localStorage.getItem('clw.control-center.v1.example-runtime')"))
 def test_initial_load_failure_disables_data_actions(self):
  self.page.route('**/data/observed.json',lambda route:route.fulfill(status=503,body='unavailable'))
  self.page.reload();self.page.wait_for_function("document.querySelector('#notice').textContent.includes('读取失败')")
  self.assertTrue(self.page.locator('#clearProject').is_disabled());self.assertEqual(self.page.locator('#projectCount').inner_text(),'—')
  self.page.locator('[data-view=routing]').click();self.assertTrue(self.page.locator('#makePacket').is_disabled())
 def test_pending_save_cancelled_when_dialog_closed(self):
  self.page.evaluate("window.labelHeld=new Promise(resolve=>window.releaseLabel=resolve);void navigator.locks.request('clw.control-center.v1.example-runtime',async()=>{window.labelLockHeld=true;document.documentElement.dataset.clwTestLabelLock='held';await window.labelHeld})")
  expect(self.page.locator('html')).to_have_attribute('data-clw-test-label-lock','held')
  self.page.get_by_role('button',name='标注账号 / 角色').first.click();self.page.locator('#aliasInput').fill('不应写入');self.page.locator('#bindingForm button[type=submit]').click();self.page.locator('#closeBinding').click();self.page.evaluate('window.releaseLabel()')
  expect(self.page.locator('#bindingForm button[type=submit]')).to_be_enabled()
  self.assertIsNone(self.page.evaluate("localStorage.getItem('clw.control-center.v1.example-runtime')"))
 def test_wide_and_narrow_render(self):
  for width in [1480,390]:
   self.page.set_viewport_size({'width':width,'height':1100});self.page.evaluate('document.fonts.ready');self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth'));path=EVIDENCE/f'control-center-{width}.png';self.page.screenshot(path=str(path),full_page=True);stats=ImageStat.Stat(Image.open(path).convert('RGB'));self.assertGreater(max(stats.stddev),4)
  self.page.set_viewport_size({'width':1480,'height':1100});self.page.locator('[data-view=timeline]').click();self.page.screenshot(path=str(EVIDENCE/'timeline.png'),full_page=True);self.page.locator('[data-view=routing]').click();self.page.screenshot(path=str(EVIDENCE/'routing.png'),full_page=True)
if __name__=='__main__':unittest.main(verbosity=2)
