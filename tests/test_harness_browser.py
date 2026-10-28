"""New harness UI in an isolated Edge context, fake protocol backend only.
No native account, browser profile, old Control Center route or model invocation.
"""
from pathlib import Path
from datetime import datetime,timezone
import json,sys,tempfile,threading,time,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_http import HarnessHTTP
from serve_control_center import create_server
from test_harness_service import FakeConnection
from playwright.sync_api import sync_playwright,expect

class BrowserTest(unittest.TestCase):
    def test_actual_page_interaction_drafts_ime_and_replay(self):
        out=ROOT/'evidence/HARNESS-MVP-20260922/browser'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');out.mkdir(parents=True)
        report={'scope':'isolated Edge against fake JSONL service, not actual model or Web Host','model_calls':0,'checks':[]}
        def check(name,value):report['checks'].append({'name':name,'passed':bool(value)});self.assertTrue(value,name)
        try:
            with tempfile.TemporaryDirectory(prefix='clw-harness-ui-') as temporary:
                service=HarnessService(Path(temporary),Path(temporary)/'state',connection_factory=FakeConnection)
                server=create_server(0);server.harness_api=HarnessHTTP(service);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();origin=f'http://127.0.0.1:{server.server_address[1]}'
                try:
                    with sync_playwright() as pw:
                        browser=pw.chromium.launch(channel='msedge',headless=True)
                        try:
                            context=browser.new_context(viewport={'width':1440,'height':960});page=context.new_page();errors=[];requests=[]
                            page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda req:requests.append(req.url))
                            page.goto(origin+'/harness.html');expect(page.locator('#connectionState')).to_contain_text('本机已连接')
                            page.locator('#connectCodex').click();expect(page.locator('#modelInfo')).to_contain_text('fixture-model')
                            check('explicit_connection_without_turn',not any(m=='turn/start' for m,p in service.connection.calls))
                            page.once('dialog',lambda d:d.accept('界面真实测试会话'));page.locator('#newThread').click();expect(page.locator('#prompt')).to_be_enabled()
                            first=service.state.listing()[0]
                            page.locator('#prompt').fill('中文输入测试')
                            page.locator('#prompt').dispatch_event('compositionstart')
                            page.locator('#prompt').dispatch_event('keydown',{'key':'Enter','code':'Enter','isComposing':True})
                            check('ime_enter_does_not_send',not any(m=='turn/start' for m,p in service.connection.calls))
                            page.locator('#prompt').dispatch_event('compositionend');page.locator('#send').click()
                            expect(page.locator('#threadMeta')).to_contain_text('正在工作')
                            check('one_real_http_turn_request',sum(m=='turn/start' for m,p in service.connection.calls)==1)
                            service.on_event({'method':'item/agentMessage/delta','params':{'threadId':first['native_id'],'turnId':'turn-1','itemId':'m1','delta':'已读取文件。'}})
                            service.on_event({'method':'item/completed','params':{'threadId':first['native_id'],'turnId':'turn-1','item':{'id':'m1','type':'agentMessage','text':'已读取文件。<script>bad()</script>'}}})
                            service.on_event({'method':'turn/completed','params':{'threadId':first['native_id'],'turn':{'id':'turn-1','status':'completed'}}})
                            expect(page.locator('#conversation')).to_contain_text('<script>bad()</script>')
                            check('public_text_not_executable_html',page.locator('#conversation script').count()==0)
                            check('stream_and_final_single_message',page.locator('.message.assistant').count()==1)
                            page.locator('#prompt').fill('父级未发送的草稿')
                            page.once('dialog',lambda d:d.accept('独立历史分支'));page.locator('#forkThread').click()
                            expect(page.locator('#threadTitle')).to_have_text('独立历史分支')
                            check('genuine_native_fork_request',sum(m=='thread/fork' for m,p in service.connection.calls)==1)
                            check('child_draft_is_independent',page.locator('#prompt').input_value()=='')
                            page.locator('#prompt').fill('子级草稿');page.locator(f'[data-thread-id="{first["id"]}"]').click()
                            expect(page.locator('#prompt')).to_have_value('父级未发送的草稿')
                            page.reload();expect(page.locator('#connectionState')).to_contain_text('本机已连接')
                            page.locator(f'[data-thread-id="{first["id"]}"]').click();expect(page.locator('#prompt')).to_have_value('父级未发送的草稿')
                            check('reload_does_not_repeat_turn',sum(m=='turn/start' for m,p in service.connection.calls)==1)
                            page.screenshot(path=str(out/'harness-desktop.png'),full_page=True)
                            page.set_viewport_size({'width':390,'height':844});page.locator('#toggleSidebar').click()
                            check('mobile_navigation_opens',page.locator('#sidebar').is_visible());page.locator(f'[data-thread-id="{first["id"]}"]').click()
                            check('mobile_has_no_horizontal_overflow',page.locator('main').bounding_box()['width']<=391)
                            page.screenshot(path=str(out/'harness-mobile.png'),full_page=True)
                            check('no_javascript_errors',not errors);check('no_external_requests',all(url.startswith(origin) for url in requests));context.close()
                        finally:browser.close()
                finally:server.shutdown();server.server_close();thread.join();service.close()
            report['status']='passed'
        except Exception as exc:
            report.update(status='failed',error_type=type(exc).__name__);raise
        finally:
            (out/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps({'report':str(out.relative_to(ROOT)/'verification.json'),'status':report['status'],'checks':len(report['checks'])}),flush=True)
if __name__=='__main__':unittest.main(verbosity=2)
