"""Actual loopback API and isolated Edge UI. All model/receiver roles synthetic."""
from pathlib import Path
from contextlib import closing
from urllib.request import Request,build_opener,ProxyHandler
from urllib.error import HTTPError
import json,os,sys,threading,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_team as base
from harness_host_client import Client
from harness_state import HarnessError
from harness_http import HarnessHTTP
from serve_control_center import create_server
from test_harness_control_plane import PAGE,URL,ORIGIN
from playwright.sync_api import sync_playwright,expect

class TeamHTTPTests(unittest.TestCase):
    def setUp(self):
        self.b=base.TeamTests();self.b.setUp()
        self.server=create_server(0);self.server.harness_api=HarnessHTTP(self.b.f.s)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin='http://127.0.0.1:'+str(self.server.server_address[1]);self.opener=build_opener(ProxyHandler({}))
        self.b.f.p=self.host;self.b.wire=self.wire
    def tearDown(self):self.server.shutdown();self.thread.join(5);self.server.server_close();self.b.tearDown()
    def request(self,route,body=None,origin=None,extra=None):
        headers={'Origin':origin or self.origin,**(extra or {})}
        if body is not None:headers['Content-Type']='application/json'
        request=Request(self.origin+'/api/harness/'+route,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers=headers)
        with self.opener.open(request,timeout=10) as response:
            raw=response.read(262145);self.assertLessEqual(len(raw),262144);return json.loads(raw)
    def host(self,target,action,**data):
        client=Client(self.origin,self.b.f.root/'state',self.b.h.state.id,target,self.b.f.sessions[target])
        return client.call(action,**data)
    def wire(self,target,action,**data):
        pair,url=self.b.pages[target]
        return self.request('control-wire',dict(action=action,generation=pair['generation'],chat_url=url,
            tab_nonce=uuid.uuid5(uuid.NAMESPACE_DNS,target).hex,**data),origin=ORIGIN,extra={'X-CLW-Control':pair['control_token']})
    def command(self,thread,action,data):
        return self.request('command',{'request_id':uuid.uuid4().hex,'thread_id':thread,'action':action,'data':data},extra={'X-CLW-Intent':self.b.f.s.intent})
    def test_readonly_team_view_exposes_no_tickets_keys_or_page_urls(self):
        self.b.f.join();self.b.enroll('child-a');data=self.request('team');raw=json.dumps(data)
        self.assertIn('receiver_confirmed',raw)
        for secret in ['clwi_','clwc_','CLW-ENROLL:','chat_url','host-access','token_hash']:self.assertNotIn(secret,raw)
        self.assertFalse(data['default_enabled'])
    def test_project_team_routes_do_not_accept_extension_or_foreign_origin(self):
        for origin in [ORIGIN,'https://outside.invalid','null']:
            with self.assertRaises(HTTPError):self.request('team',origin=origin)
            with self.assertRaises(HTTPError):self.request('command',{'request_id':uuid.uuid4().hex,'action':'team.invite','data':{}},origin=origin)
    def test_ui_invitation_is_explicit_does_not_create_model_or_business_request(self):
        rejected=self.request('command',{'request_id':uuid.uuid4().hex,'thread_id':self.b.f.parent['id'],'action':'team.invite','data':{}},extra={'X-CLW-Intent':self.b.f.s.intent})
        self.assertEqual(rejected['state'],'rejected')
        with closing(self.b.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_carrier_invites').fetchone()[0],0)
        r=self.command(self.b.f.parent['id'],'team.invite',{'confirm':True,'allow_rebind':False,'title':'Isolated new receiver','ttl_seconds':600,'reason':'operator test'})
        self.assertFalse(r['model_created']);self.assertFalse(r['browser_created']);self.assertIn('bootstrap_text',r)
        with closing(self.b.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
    def test_ui_recover_enroll_resolves_unique_pending_orphan_without_exposing_ticket(self):
        self.b.f.join()
        child=self.b.f.p('main','branches')['children'][0]
        invite=self.b.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'fixture orphan recovery'})
        before=self.b.f.p('child-a','read',request_id=None) if False else None
        result=self.command(self.b.f.parent['id'],'team.recover-enroll',{
            'confirm':True,'existing_thread_id':child['thread_id'],'receiver_session':'wc_sess_zzzzzzzzzzzzzzzz',
            'runtime_event_id':'evt_'+'d'*32,'reason':'Operator verified fixture Runtime session'})
        self.assertEqual(result['state'],'receiver_enrolled');self.assertTrue(result['browser_ticket_required'])
        raw=json.dumps(result)
        self.assertNotIn('clwi_',raw);self.assertNotIn(invite['invitation_id'],raw)
        with closing(self.b.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_carrier_invites WHERE id=?',(invite['invitation_id'],)).fetchone()[0],'accepted')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)

    def test_ui_recover_enroll_bad_runtime_identity_is_rejected_without_consuming_invite(self):
        self.b.f.join();child=self.b.f.p('main','branches')['children'][0]
        invite=self.b.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'fixture'})
        bad=self.command(self.b.f.parent['id'],'team.recover-enroll',{
            'confirm':True,'existing_thread_id':child['thread_id'],'receiver_session':'not-a-session',
            'runtime_event_id':'evt_'+'e'*32,'reason':'bad fixture'})
        self.assertEqual(bad['state'],'rejected')
        with closing(self.b.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_carrier_invites WHERE id=?',(invite['invitation_id'],)).fetchone()[0],'pending')

    def test_real_http_partial_result_original_M_resume_and_second_result(self):
        r,run,a,b=self.b.parallel_setup();_,ga=self.b.send_receive('child-a');_,gb=self.b.send_receive('child-b')
        self.b.final('child-a',ga,'First actual HTTP fixture result');_,gm=self.b.send_receive('main')
        self.assertEqual(gm['original_claim_id'],self.b.f.claim);self.assertEqual(gm['request_id'],r)
        context=self.b.call('context',{'run_id':run['run_id'],'after_seq':0});self.assertEqual(context['run']['dispatches'],3)
        self.b.call('result',{'run_id':run['run_id'],'request_id':a['request_id']});self.b.wait(run,after=context['next_after'],mode='any')
        self.b.final('child-b',gb,'Second actual HTTP fixture result');_,gm2=self.b.send_receive('main')
        self.assertEqual(gm2['original_claim_id'],self.b.f.claim);self.assertEqual(gm2['request_id'],r)
        self.b.call('result',{'run_id':run['run_id'],'request_id':b['request_id']})
        self.b.call('close',{'run_id':run['run_id'],'claim_id':self.b.f.claim,'summary':'Both full fixture results reviewed','references':[]})
        self.b.f.finish('main',r,self.b.f.claim)
        self.assertEqual(self.host('main','read',request_id=r)['phase'],'completed')
        self.assertIsNone(self.b.f.s.connection);self.assertEqual(self.b.f.bridge.posts,[])
    def test_http_scope_and_run_revision_cannot_be_changed_by_wrong_worker(self):
        self.b.f.join();r,run=self.b.start_run()
        with self.assertRaises(HarnessError):self.b.call('pause',{'run_id':run['run_id'],'reason':'wrong actor'},target='child-a')
        p=self.command(self.b.f.parent['id'],'team.pause',{'confirm':True,'run_id':run['run_id'],'reason':'operator pause'})
        self.assertEqual(p['state'],'paused')
        failed=self.command(self.b.f.parent['id'],'team.resume',{'confirm':True,'run_id':run['run_id'],'expected_revision':0})
        self.assertEqual(failed['state'],'rejected')
    def test_edge_panel_shows_orphan_runtime_recovery_only_for_pending_rebind(self):
        self.b.f.join();child=self.b.f.p('main','branches')['children'][0]
        self.b.call('invite',{'target':'child-a','allow_rebind':True,'ttl_seconds':600,'reason':'fixture'})
        post=[];errors=[]
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            try:
                ctx=browser.new_context(viewport={'width':1100,'height':850})
                ctx.route('**/*',lambda route:(post.append(route.request.url) if route.request.method=='POST' else None,route.continue_())[1] if route.request.url.startswith(self.origin+'/') else route.abort())
                page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(self.origin+'/harness.html')
                page.locator('[data-thread-id="'+self.b.f.parent['id']+'"]').click();page.locator('#showTeam').click()
                card=page.locator('#detailContent section').filter(has_text='独立分支 child-a')
                expect(card.get_by_text('高级：恢复历史 orphan 分支')).to_be_visible()
                card.get_by_text('高级：恢复历史 orphan 分支').click()
                self.assertEqual(post,[])
                page.on('dialog',lambda d:d.accept())
                card.get_by_label('接收对话 Runtime Session').fill('wc_sess_zzzzzzzzzzzzzzzz')
                card.get_by_label('Runtime 账本事件').fill('evt_'+'f'*32)
                card.get_by_role('button',name='确认恢复到这个真实接收 Session').click()
                expect(page.locator('#detailContent')).to_contain_text('接收对话已登记')
                self.assertEqual(len(post),1);self.assertEqual(errors,[])
                with closing(self.b.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
            finally:browser.close()

    def test_isolated_Edge_new_panel_is_readonly_until_operator_invitation(self):
        self.b.f.join();post=[];errors=[]
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            try:
                ctx=browser.new_context(viewport={'width':1440,'height':1000})
                def gate(route):
                    if not route.request.url.startswith(self.origin+'/'):route.abort();return
                    if route.request.method=='POST':post.append(route.request.url)
                    route.continue_()
                ctx.route('**/*',gate);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(self.origin+'/harness.html');expect(page.locator('#connectionState')).to_contain_text('本机已连接')
                page.locator('[data-thread-id="'+self.b.f.parent['id']+'"]').click();page.locator('#showTeam').click()
                expect(page.locator('#detailContent')).to_contain_text('自动协作');expect(page.locator('#detailContent')).to_contain_text('添加一个真实 ChatGPT 对话后即可长期复用')
                self.assertEqual(post,[])
                page.on('dialog',lambda d:d.accept())
                card=page.locator('#detailContent section').filter(has_text='独立分支 child-a')
                card.get_by_role('button',name='生成接入／恢复邀请').click()
                expect(card.locator('textarea')).to_have_value(__import__('re').compile('.*CLW 对话接入.*',__import__('re').S))
                self.assertEqual(len(post),1)
                out=Path(os.environ.get('CLW_AUTONOMOUS_TEST_DIR',str(self.b.f.root)));out.mkdir(parents=True,exist_ok=True)
                # Do not persist the one-time setup capability in screenshots.
                card.locator('textarea').evaluate("node=>{node.value='一次性接入文本已生成（测试截图遮盖）'}")
                page.screenshot(path=str(out/'team-panel-desktop.png'))
                page.set_viewport_size({'width':390,'height':844});self.assertTrue(page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
                page.screenshot(path=str(out/'team-panel-mobile.png'));self.assertEqual(errors,[])
                with closing(self.b.h.state.connect()) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
            finally:browser.close()

if __name__=='__main__':unittest.main(verbosity=2)
