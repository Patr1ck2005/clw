from __future__ import annotations
from pathlib import Path
import sys,os,json,threading,time,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'tests'))
from live_fixture import Fixture,TOKEN,P1,P2,S1,S2,OLD
from live_transport import Transport
from live_observer import Observer
from serve_control_center import create_server
from playwright.sync_api import sync_playwright
OUT=Path(os.environ.get('CLW_TEST_EVIDENCE_DIR',str(ROOT/'evidence/WB002-2/screenshots'))).resolve()
if not OUT.is_relative_to((ROOT/'evidence/WB002-2').resolve()):raise ValueError('Scoped screenshots only')

class BrowserTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True);OUT.mkdir(parents=True,exist_ok=True)
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.pw.stop()
 def setUp(self):
  self.f=Fixture();self.o=Observer(Transport(self.f.origin,TOKEN),cache_secs=0)
  self.server=create_server(0,self.o);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.server.server_address[1]}/'
  self.ctx=self.browser.new_context(viewport={'width':1480,'height':1120});self.p=self.ctx.new_page();self.errors=[];self.requests=[];self.p.on('pageerror',lambda x:self.errors.append(str(x)));self.p.on('request',lambda r:self.requests.append(r.url))
  self.p.goto(self.url+'?live=1');self.p.wait_for_function("() => document.querySelector('#projectCount').textContent==='2'")
 def tearDown(self):
  self.assertEqual(self.errors,[]);self.assertTrue(all(url.startswith(self.url) or url.startswith('blob:') for url in self.requests));self.ctx.close();self.server.shutdown();self.server.server_close();self.thread.join();self.f.close()
 def project(self,pid=P1):
  self.p.locator(f'[data-project-id="{pid}"]').click();self.p.wait_for_function("() => document.querySelector('#sessionCount').textContent==='1' && document.querySelector('#liveState').dataset.state==='connected'")
 def wait_connected(self):self.p.wait_for_function("() => document.querySelector('#liveState').dataset.state==='connected'")
 def test_project_discovery_and_exact_timeline(self):
  self.project();self.p.get_by_role('button',name='查看调用 →').click();self.p.wait_for_function("() => document.querySelector('#timelineSummary').textContent.includes('1/1')")
  self.assertIn('已接受 · 非完成',self.p.locator('#eventRows').inner_text());self.assertIn('调用计数未提供',self.p.locator('#sessionList').inner_text())
 def test_project_switch_does_not_show_other_session(self):
  self.project();self.project(P2);self.assertEqual(self.p.locator('.session-card').get_attribute('data-session-id'),S2);self.assertNotIn(S1,self.p.locator('#jobList').inner_text())
 def test_project_change_clears_old_timeline_before_reply(self):
  self.project();self.p.get_by_role('button',name='查看调用 →').click();self.p.wait_for_function("() => document.querySelector('#timelineSummary').textContent.includes('1/1')")
  self.p.locator('[data-view=overview]').click();gate=threading.Event();self.f.gate=gate
  try:
   self.p.locator(f'[data-project-id="{P2}"]').click()
   self.assertEqual(self.p.locator('#eventRows tr').count(),0)
   self.assertEqual(self.p.locator('#timelineSession').input_value(),'')
  finally:gate.set();self.f.gate=None
  self.wait_connected()
 def test_exact_session_lookup_outside_latest_window(self):
  self.f.expanded=True;self.project();self.p.locator('#lookupSession').fill(OLD);self.p.locator('#lookupSessionButton').click();self.p.wait_for_function("() => document.querySelector('#sessionCount').textContent==='2'")
  self.assertIn('截断',self.p.locator('#liveCoverage').inner_text());self.assertEqual(self.p.locator('#timelineSession').input_value(),OLD)
 def test_pause_aborts_only_observation(self):
  self.project();self.p.locator('#pauseLive').click();n=len(self.f.requests);time.sleep(.1);self.assertEqual(len(self.f.requests),n);self.assertEqual(self.p.locator('#liveState').get_attribute('data-state'),'paused');self.assertEqual(self.p.locator('#sessionCount').inner_text(),'1')
 def test_live_updates_preserve_task_packet(self):
  self.project();self.p.locator('[data-view=routing]').click();self.p.locator('#goal').fill('完整任务不可删');self.p.locator('#acceptance').fill('中文证据');self.p.locator('#makePacket').click();text=self.p.locator('#packetPreview').input_value()
  self.f.change=5;self.p.locator('#retryLive').click();self.wait_connected();self.assertEqual(self.p.locator('#packetPreview').input_value(),text)
 def test_live_update_keeps_open_annotation_draft(self):
  self.project();self.p.get_by_role('button',name='标注账号 / 角色').click();self.p.locator('#aliasInput').fill('必须保留草稿')
  # Modal remains open while normal foreground timer refreshes changed data.
  before=len(self.f.requests);self.f.change=7
  self.p.wait_for_timeout(5600)
  self.assertGreater(len(self.f.requests),before,'Foreground timer must actually query, not just preserve an idle draft')
  self.assertTrue(self.p.locator('#bindingDialog').is_visible());self.assertEqual(self.p.locator('#aliasInput').input_value(),'必须保留草稿')
 def test_saved_labels_survive_other_project_and_back(self):
  self.project();self.p.get_by_role('button',name='标注账号 / 角色').click();self.p.locator('#aliasInput').fill('我的账号A');self.p.locator('#bindingForm button[type=submit]').click();self.p.wait_for_function("() => !document.querySelector('#bindingDialog').open")
  self.project(P2);self.project();self.assertIn('我的账号A',self.p.locator('#sessionList').inner_text())
 def test_auth_expiry_erases_view_not_secret_leak(self):
  self.project();self.f.overrides['/api/runtime/status']=(401,{'bad':TOKEN},{})
  self.p.locator('#retryLive').click();self.p.wait_for_function("() => document.querySelector('#liveState').dataset.state==='auth_required'")
  self.assertEqual(self.p.locator('.session-card').count(),0);self.assertEqual(self.p.locator('#projectCount').inner_text(),'—');self.assertNotIn(TOKEN,self.p.content())
 def test_503_stale_then_reconnect(self):
  self.project();self.f.overrides['/api/runtime/status']=(503,{},{});self.p.locator('#retryLive').click();self.p.wait_for_function("() => document.querySelector('#liveState').dataset.state==='stale'")
  self.assertEqual(self.p.locator('.session-card').count(),1);self.assertIn('过期',self.p.locator('#sourceTitle').inner_text())
  self.f.overrides.clear()
  for slot in self.o.slots.values():slot.deadline=0
  self.p.locator('#retryLive').click();self.wait_connected()
 def test_snapshot_import_stops_live_and_cannot_spoof_live(self):
  source=json.loads((ROOT/'apps/control-center/data/observed.json').read_text(encoding='utf-8'));source['source']['live']=True
  self.p.locator('#importSnapshot').set_input_files({'name':'snapshot.json','mimeType':'application/json','buffer':json.dumps(source).encode()});self.p.wait_for_function("() => document.querySelector('#projectCount').textContent==='13'")
  self.assertIn('非实时',self.p.locator('#sourceTitle').inner_text());self.assertTrue(self.p.locator('#pauseLive').is_disabled())
 def test_backend_search_is_distinct_from_local_filter(self):
  self.p.locator('#liveQuery').fill('Beta');self.p.locator('#searchLive').click();self.p.wait_for_function("() => document.querySelector('#projectCount').textContent==='1'")
  self.assertEqual(self.p.locator('.project-item').get_attribute('data-project-id'),P2)
 def test_screenshots_layout_and_no_external_calls(self):
  self.project()
  for width in (1480,390):
   self.p.set_viewport_size({'width':width,'height':1120});self.assertTrue(self.p.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));self.p.screenshot(path=str(OUT/f'live-overview-{width}.png'),full_page=True)
  self.p.set_viewport_size({'width':1480,'height':1120});self.p.get_by_role('button',name='查看调用 →').click();self.p.wait_for_function("() => document.querySelector('#timelineSummary').textContent.includes('1/1')");self.p.screenshot(path=str(OUT/'live-timeline.png'),full_page=True)
if __name__=='__main__':unittest.main(verbosity=2)
