"""Control carrier over actual loopback HTTP and isolated Edge DOM.

Synthetic receiver only; never contacts real ChatGPT, native backend or live DB.
"""
from pathlib import Path
from contextlib import closing
import json,sys,threading,unittest,os
from urllib.request import Request,build_opener,ProxyHandler,HTTPRedirectHandler
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_collaboration as fixtures
from harness_http import HarnessHTTP
from serve_control_center import create_server
from test_harness_control_plane import PAGE,URL,ORIGIN,receiver_marker
from playwright.sync_api import sync_playwright,expect

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*a,**k):raise ValueError('test redirect rejected')

class HTTPControlTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.CollaborationTests();self.f.setUp();self.f.join()
        self.server=create_server(0);self.server.harness_api=HarnessHTTP(self.f.s)
        self.t=threading.Thread(target=self.server.serve_forever,daemon=True);self.t.start()
        self.origin='http://127.0.0.1:'+str(self.server.server_address[1])
        self.op=build_opener(ProxyHandler({}),NoRedirect());self.peers={}
    def tearDown(self):self.server.shutdown();self.t.join(5);self.server.server_close();self.f.tearDown()
    def request(self,route,body=None,origin=None,headers=None,method=None):
        hdr={'Origin':origin or self.origin,**(headers or {})}
        if body is not None:hdr['Content-Type']='application/json'
        req=Request(self.origin+'/api/harness/'+route,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers=hdr,method=method)
        with self.op.open(req,timeout=8) as r:
            data=r.read(262145);self.assertLessEqual(len(data),262144)
            return json.loads(data) if data else {}
    def p(self,target,action,**data):
        return self.request('host-control',dict(action=action,store_id=self.f.s.state.id,target_id=target,session_id=self.f.sessions[target],**data),headers={'X-CLW-Host':self.f.key})
    def pair(self,target):
        code=self.p(target,'control-code',confirm=True,model_label='GPT-5.6 Sol',effort_label='Extra High')['pair_code']
        url=URL if target=='main' else URL.replace('11111111','33333333')
        result=self.request('control-wire',dict(action='pair',code=code,chat_url=url,tab_nonce='a'*32),origin=ORIGIN)
        self.peers[target]=(result,url)
        return result
    def w(self,target,action,**data):
        p,url=self.peers[target]
        return self.request('control-wire',dict(action=action,generation=p['generation'],chat_url=url,tab_nonce='a'*32,**data),origin=ORIGIN,headers={'X-CLW-Control':p['control_token']})
    def delegate(self):
        r=self.f.start();d=self.f.delegate(r);self.f.yield_parent(r);return r,d
    def test_cross_origin_and_wrong_hosts_cannot_control(self):
        self.pair('main')
        for origin in ['https://evil.test',self.origin,'null']:
            with self.assertRaises(HTTPError) as e:self.request('control-wire',dict(action='pair'),origin=origin)
            self.assertEqual(e.exception.code,403)
        with self.assertRaises(HTTPError):self.request('control-wire',{},origin=ORIGIN,headers={'Host':'evil.test'})
    def test_extension_cannot_access_regular_project_host_control(self):
        self.pair('main')
        with self.assertRaises(HTTPError):self.request('host-control',{},origin=ORIGIN)
        with self.assertRaises(HTTPError):self.w('main','claim',request_id='forged')
    def test_wire_body_and_method_bounds(self):
        with self.assertRaises(HTTPError):self.request('control-wire',{'action':'invalid','blob':'汉'*90000},origin=ORIGIN)
        with self.assertRaises(HTTPError):self.request('control-wire',{'action':'pulse','junk':'x'*9000},origin=ORIGIN)
        with self.assertRaises(HTTPError):self.request('control-wire',origin=ORIGIN)
        with self.assertRaises(HTTPError):self.request('control-wire',origin=ORIGIN,method='OPTIONS',headers={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-clw-host'})
    def test_preflight_is_narrow_and_side_effect_free(self):
        self.request('control-wire',origin=ORIGIN,method='OPTIONS',headers={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-clw-control, content-type'})
        self.assertFalse(self.p('main','control-status')['paired'])
    def test_http_child_return_full_result_parent_original_claim(self):
        self.pair('main');self.pair('child-a');r,d=self.delegate()
        offer=self.w('child-a','pulse',page=PAGE)
        self.assertEqual(offer['request_id'],d['child_request_id'])
        self.w('child-a','dispatch',attempt_id=offer['attempt_id'],page=PAGE)
        child=self.p('child-a','control-receive',attempt_id=offer['attempt_id'])
        self.assertEqual(child['delegation']['parent_request_id'],r)
        self.p('child-a','read',request_id=d['child_request_id'])
        body='Isolated full public review; no actual Web model. '+('R'*5000)
        self.p('child-a','reply',request_id=d['child_request_id'],claim_id=child['original_claim_id'],reply_id=fixtures.uid(),status='completed',text=body)
        summary=self.p('main','results',request_id=r,claim_id=self.f.claim)
        self.assertTrue(summary['children'][0]['reply_truncated'])
        full=self.p('main','result',request_id=r,claim_id=self.f.claim,delegation_id=d['delegation_id'],after_seq=0)
        self.assertEqual(full['items'][0]['data']['text'],body);self.assertFalse(full['has_more'])
        offered=self.w('main','pulse',page=PAGE);self.w('main','dispatch',attempt_id=offered['attempt_id'],page=PAGE)
        parent=self.p('main','control-receive',attempt_id=offered['attempt_id'])
        self.assertEqual(parent['original_claim_id'],self.f.claim);self.assertTrue(parent['already_claimed'])
        self.p('main','read',request_id=r)
        self.p('main','reply',request_id=r,claim_id=self.f.claim,reply_id=fixtures.uid(),status='completed',text='Isolated parent reconciled original claim.')
        self.assertEqual(self.p('main','read',request_id=r)['phase'],'completed')
        self.assertIsNone(self.f.s.connection);self.assertEqual(self.f.bridge.posts,[])

    def test_unified_http_bootstrap_uses_prior_companion_trust_and_no_target_or_code(self):
        code=self.f.s.host_bridge.recovery.pairing_code(self.f.parent['id'])['pair_code']
        self.f.s.host_bridge.recovery.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=URL))
        parent,delegated=self.delegate();child_url=URL.replace('11111111','77777777');nonce='b'*32
        boot=self.request('control-wire',dict(action='bootstrap',chat_url=child_url,tab_nonce=nonce,page=PAGE,confirm_low_cost=True,enrollment=receiver_marker(self.f)),origin=ORIGIN)
        self.assertEqual(boot['state'],'one_confirmed_receiver');self.assertTrue(boot['auto_bind_safe']);self.assertFalse(boot['internal_target_required']);self.assertFalse(boot['pair_code_required'])
        raw=json.dumps(boot);self.assertNotIn('target_id',raw);self.assertNotIn('request_id',raw)
        candidate=boot['candidates'][0];self.assertEqual(candidate['title'],'独立分支 child-a')
        bound=self.request('control-wire',dict(action='bind',discovery_id=candidate['discovery_id'],confirm=True,confirm_low_cost=True,
            chat_url=child_url,tab_nonce=nonce,page=PAGE),origin=ORIGIN)
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])
        self.assertNotIn('target_id',bound);self.assertNotIn('pair_code',bound);self.assertFalse(bound['pair_code_required'])
        self.assertEqual(self.f.p('child-a','read',request_id=delegated['child_request_id'])['phase'],'queued')

    def test_http_explicit_page_authorization_binds_enrolled_receiver_without_receipt(self):
        code=self.f.s.host_bridge.recovery.pairing_code(self.f.parent['id'])['pair_code']
        self.f.s.host_bridge.recovery.wire(ORIGIN,None,dict(action='pair',code=code,chat_url=URL))
        parent,delegated=self.delegate();receiver_marker(self.f)
        child_url=URL.replace('11111111','56565656');nonce='e'*32
        boot=self.request('control-wire',dict(action='bootstrap',chat_url=child_url,tab_nonce=nonce,
            page=PAGE,confirm_low_cost=True,confirm_page_binding=True),origin=ORIGIN)
        self.assertEqual(len(boot['candidates']),1)
        raw=json.dumps(boot,ensure_ascii=False)
        for hidden in ('target_id','session_id','request_id'):self.assertNotIn(hidden,raw)
        self.assertFalse(boot['pair_code_required'])
        candidate=boot['candidates'][0]
        bound=self.request('control-wire',dict(action='bind',discovery_id=candidate['discovery_id'],
            confirm=True,confirm_low_cost=True,chat_url=child_url,tab_nonce=nonce,page=PAGE),origin=ORIGIN)
        self.assertEqual(bound['adopted_request_id'],delegated['child_request_id'])
        self.assertEqual(self.f.p('child-a','read',request_id=delegated['child_request_id'])['phase'],'queued')
        with closing(self.f.s.host_bridge.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',
                (delegated['child_request_id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_page_authorizations').fetchone()[0],0)

    def test_isolated_Edge_runs_shipped_page_and_content_single_send(self):
        r,d=self.delegate();pair=self.pair('child-a')
        self.p('child-a','control-adopt',confirm=True,request_id=d['child_request_id'])
        url=self.peers['child-a'][1];seen=[];errors=[];outside=[]
        html='''<!doctype html><html><meta charset="utf-8"><body>
          <article data-testid="conversation-turn-1" data-turn="user"><div id="user" data-message-author-role="user" data-message-id="u1">Isolated fixture only</div></article>
          <article data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1">Fixture response</div></article>
          <form>
            <button class="__composer-pill __composer-pill--neutral" aria-haspopup="menu" data-tone="neutral">GPT-5.6 Sol Extra High</button>
            <textarea data-testid="prompt-textarea" id="prompt-textarea"></textarea><button data-testid="send-button" id="send" type="button">Send</button>
          </form>
          <script>window.sends=0;document.getElementById('send').onclick=()=>{window.sends++;document.body.dataset.sends=String(window.sends);document.getElementById('user').parentElement.setAttribute('data-testid','conversation-turn-3');document.getElementById('prompt-textarea').value='';};</script>
          </body></html>'''
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',headless=True)
            try:
                context=browser.new_context();page=context.new_page()
                def route(req):
                    if req.request.url==url:req.fulfill(status=200,content_type='text/html',body=html)
                    else:outside.append(req.request.url);req.abort()
                context.route('**/*',route)
                page.on('pageerror',lambda e:errors.append(str(e)))
                def bridge(message):
                    if message['type']=='control-hello':return {'ok':True,'value':{'model_label':pair['model_label'],'effort_label':pair['effort_label'],'transport_active':True}}
                    if message['type']=='control-transport':return {'ok':True,'value':{'active':True}}
                    self.assertEqual(message['type'],'control-wire')
                    data=message['data'];seen.append(data['action'])
                    try:return {'ok':True,'value':self.w('child-a',**data)}
                    except HTTPError as e:return {'ok':False,'error':'isolated HTTP '+str(e.code)}
                page.expose_function('__clwFixtureWire',bridge)
                page.goto(url)
                page.evaluate('() => {window.chrome={runtime:{sendMessage:m=>window.__clwFixtureWire(m)}}}')
                for name in ('control-policy.js','control-page.js','control-content.js'):page.add_script_tag(content=(ROOT/'apps/web-recovery-companion'/name).read_text(encoding='utf-8'))
                page.wait_for_timeout(4500)
                self.assertEqual(page.locator('body').get_attribute('data-sends'),'1',
                    'browser carrier did not send: actions='+repr(seen)+' errors='+repr(errors)+' phase='+self.p('child-a','read',request_id=d['child_request_id'])['phase'])
                phase=None
                for _ in range(25):
                    phase=self.p('child-a','read',request_id=d['child_request_id'])['phase']
                    if phase=='processing':break
                    page.wait_for_timeout(200)
                self.assertEqual(phase,'processing')
                self.assertEqual(page.evaluate('window.sends'),1);self.assertEqual(seen.count('dispatch'),1);self.assertEqual(seen.count('sent'),1)
                page.evaluate('''() => {const article=document.createElement('article');article.dataset.testid='conversation-turn-4';article.innerHTML='<div data-message-author-role="assistant" data-message-id="a2"><div class="markdown">Complete isolated browser public result.</div></div>';document.body.append(article);}''')
                phase=None
                for _ in range(45):
                    phase=self.p('child-a','read',request_id=d['child_request_id'])['phase']
                    if phase=='completed':break
                    page.wait_for_timeout(200)
                self.assertEqual(phase,'completed')
                self.assertEqual(seen.count('result'),1);self.assertEqual(page.evaluate('window.sends'),1)
                full=self.p('main','result',request_id=r,claim_id=self.f.claim,delegation_id=d['delegation_id'],after_seq=0)
                self.assertEqual(full['items'][0]['data']['text'],'Complete isolated browser public result.')
                self.assertFalse(outside);self.assertFalse(errors)
                page.evaluate('() => window.__clwControlStop()')
                # Install-time code-like error text must not be considered terminal.
                page.evaluate('''() => {const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);a.innerHTML='<div class="markdown"><button>无法思考</button></div>'; }''')
                snapshot=page.evaluate('() => window.CLWControlPage.inspect()');self.assertEqual(snapshot['failure_kind'],'');self.assertTrue(snapshot['controls_known']);self.assertEqual(snapshot['model_label'],'GPT-5.6 Sol');self.assertEqual(snapshot['effort_label'],'Extra High')
                page.evaluate('''() => {[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1).innerHTML='<div role="alert">无法思考</div>'; }''')
                snapshot=page.evaluate('() => window.CLWControlPage.inspect()');self.assertEqual(snapshot['failure_kind'],'cannot_think')
                self.assertNotIn('Isolated fixture only',json.dumps(snapshot))
            finally:browser.close()
    def test_panel_command_permission_confirmation_and_no_body_leak(self):
        body={'request_id':fixtures.uid(),'action':'control.pair','thread_id':self.f.parent['id'],'data':{'confirm':False,'model_label':'GPT-5.6 Sol','effort_label':'Extra High'}}
        result=self.request('command',body,headers={'X-CLW-Intent':self.f.s.intent})
        self.assertEqual(result['state'],'rejected')
        snapshot=self.request('control?thread_id='+self.f.parent['id']);self.assertFalse(snapshot['paired'])

    def test_actual_control_panel_is_read_only_until_explicit_opt_in(self):
        posts=[];errors=[]
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',headless=True)
            try:
                page=browser.new_page(viewport={'width':1440,'height':1000})
                def gate(route):
                    if route.request.method=='POST':posts.append(route.request.url);route.abort()
                    elif route.request.url.startswith(self.origin+'/'):route.continue_()
                    else:route.abort()
                page.route('**/*',gate);page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(self.origin+'/harness.html')
                page.locator('[data-thread-id="'+self.f.parent['id']+'"]').click();page.locator('.sidebar-advanced summary').click();page.locator('#showControl').click()
                expect(page.locator('#detailContent')).to_contain_text('高级诊断')
                expect(page.locator('#detailContent')).to_contain_text('未启用')
                expect(page.locator('#controlModelLabel')).to_have_value('GPT-5.6 Sol')
                expect(page.locator('#controlEffortLabel')).to_have_value('Extra High')
                expect(page.locator('#controlAdopt')).to_be_disabled()
                out=os.environ.get('CLW_CONTROL_TEST_DIR')
                if out:
                    dest=Path(out).resolve();self.assertTrue(any(dest.is_relative_to(ROOT/x) for x in ('evidence/CONTROL-CORE-20260923/runs','evidence/AUTONOMOUS-RUNTIME-20260924/runs')))
                    page.screenshot(path=str(dest/'control-panel-desktop.png'))
                page.set_viewport_size({'width':390,'height':844})
                self.assertTrue(page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
                if out:page.screenshot(path=str(dest/'control-panel-mobile.png'))
                self.assertFalse(posts);self.assertFalse(errors);self.assertFalse(self.p('main','control-status')['paired'])
            finally:browser.close()

if __name__=='__main__':unittest.main(verbosity=2)
