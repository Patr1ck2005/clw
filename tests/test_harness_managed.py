"""Managed transport tests; no actual browser/model acceptance is asserted."""
from pathlib import Path
from contextlib import closing
import sys,json,re,uuid,unittest,hashlib,os,subprocess,tempfile
from datetime import datetime,timezone
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_collaboration as fixture
from test_harness_control_plane import PAGE
from harness_state import HarnessError
from harness_managed_protocol import parse_controller_reply
from harness_user_authorization import user_authorization
from harness_work_package import WORK_PACKAGE_GUIDANCE

class ManagedTests(unittest.TestCase):
    def test_model_fault_is_local_but_operator_pause_still_cascades(self):
        parent,_=self.enroll();child,_=self.enroll(parent);sibling,_=self.enroll(parent)
        self.m.browser('page-issue',{'page_id':parent,'kind':'usage_limit','detail':'public quota limit'})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[parent]['paused']);self.assertEqual(rows[parent]['issue_kind'],'usage_limit')
        self.assertFalse(rows[child]['paused']);self.assertFalse(rows[sibling]['paused'])
        self.m.browser('page-issue',{'page_id':child,'kind':'control_failed','detail':'local control'})
        self.m.browser('pause',{'page_id':child,'paused':False})
        self.m.browser('pause',{'page_id':parent,'paused':True})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[child]['paused']);self.assertTrue(rows[sibling]['paused'])
        with self.assertRaises(HarnessError):self.m.browser('pause',{'page_id':child,'paused':False})
        # A later passive quota report cannot erase explicit pause ownership.
        self.m.browser('page-issue',{'page_id':parent,'kind':'usage_limit','detail':'still limited'})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[child]['pause_origin']['source'],'operator')

    def setUp(self):
        self.f=fixture.CollaborationTests();self.f.setUp();self.h=self.f.s.host_bridge;self.m=self.h.managed;self.sessions={}
    def tearDown(self):self.f.tearDown()
    def reserve(self,parent=None,**settings):
        page='web-'+str(uuid.uuid4())
        # Historical project fixtures retain explicit finite budgets. New
        # personal-edition NULL defaults are covered by test_personal_runtime.
        p={'page_id':page,'title':'真实对话占位','root':str(self.f.root),'model':'GPT-6 Astra Pro','effort':'最高','first_turn_mode':'prepare_v1',
           'duration_seconds':21600,'max_dispatches':40,**settings}
        if parent:r=self.private(parent,'create',{k:v for k,v in p.items() if k not in ('model','effort')})
        else:r=self.m.browser('reserve',p)
        return page,r
    def private(self,page,op,p,key=None):
        return self.h.private(self.f.key,{'action':'managed','store_id':self.h.state.id,'target_id':page,'session_id':self.sessions[page],'op':op,'operation_id':key or str(uuid.uuid4()),'payload':p})
    def enroll(self,parent=None,**settings):
        page,r=self.reserve(parent,**settings);self.sessions[page]='wc_sess_'+uuid.uuid4().hex
        ticket=re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0]
        reply=self.private(page,'enroll',{'ticket':ticket,'project':'own-project','root':str(self.f.root)})
        preparation={'preparation_markdown':'Fixture research plan\n'+reply['browser_marker'],'source_hash':hashlib.sha256(b'Fixture research plan').hexdigest()} if settings.get('first_turn_instructions') else {}
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':reply['browser_marker'],**preparation})
        return page,reply
    def wire(self,pageid,action,**p):
        return self.m.browser('wire',{'page_id':pageid,'data':{'action':action,'page':{**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高'},**p}})
    def test_public_model_locale_is_compatible_at_original_dispatch_and_send_boundaries(self):
        page,b=self.enroll(model='GPT-6 · 最新',effort='Pro')
        self.f.command(b['thread_id'],'message.send',{'text':'Implement and verify the complete approved module.'})
        active={**PAGE,'model_label':'GPT-6 · Latest','effort_label':'Pro'}
        for model,effort in [('GPT-5.6 · Latest','Pro'),('GPT-6.1 · Latest','Pro'),
                             ('GPT-6 · Newest','Pro'),('GPT-6 · Latest','Extra High')]:
            with self.subTest(model=model,effort=effort):
                self.assertEqual(self.wire(page,'pulse',page={**active,'model_label':model,'effort_label':effort})['state'],'page_not_safe_or_model_mismatch')
        offer=self.wire(page,'pulse',page=active);self.assertEqual(offer['state'],'offer')
        self.wire(page,'dispatch',page=active,attempt_id=offer['attempt_id'])
        result=self.wire(page,'sent',page={**active,'user_hash':'b'*64,'generating':True},attempt_id=offer['attempt_id'],assistant_before_hash='c'*64)
        self.assertEqual(result['state'],'browser_result_pending')
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['model'],'gpt-6 · 最新');self.assertEqual(row['latest_request']['attempt_id'],offer['attempt_id'])
    def test_real_session_then_public_marker_required(self):
        page,r=self.reserve()
        with self.assertRaises(HarnessError):self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/a','public_text':'fake'})
        self.assertEqual(self.m.browser('list',{})['pages'][0]['phase'],'reserved')
    def test_invalid_access_is_rejected_before_page_ticket_or_model_send(self):
        for access,paths in [('write',[]),('read',['notes']),('write',['../outside']),('write',['notes','NOTES'])]:
            with self.subTest(access=access,paths=paths):
                with self.assertRaises(HarnessError):self.reserve(access=access,write_paths=paths)
                self.assertEqual(self.m.browser('list',{})['pages'],[])
        page,_=self.reserve(access='write',write_paths=['notes','proofs'])
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['write_paths'],['notes','proofs']);self.assertEqual(row['bootstrap_state'],'pending')
    def test_user_consent_keeps_enrollment_read_only_and_task_scope_unchanged(self):
        page,r=self.reserve()
        self.assertEqual(r['bootstrap_text'].count(user_authorization().strip()),0)
        self.assertIn('仅接入，不开始项目写入',r['bootstrap_text'])
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['access'],'read');self.assertEqual(row['write_paths'],[])
    def test_valid_write_enrollment_binds_with_the_exact_declared_scope(self):
        page,_=self.enroll(access='write',write_paths=['notes','proofs'])
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        with closing(self.h.state.connect()) as db:
            scope=self.h.team.scopes.scope(db,row['thread_id'])
        self.assertEqual(row['phase'],'bound');self.assertTrue(row['intake']['tool_receipt'])
        self.assertEqual(scope['access'],'write');self.assertEqual(json.loads(scope['write_paths']),['notes','proofs'])
    def test_bound_session_activity_is_read_only_scoped_and_has_no_credentials(self):
        self.check_session_activity('B')
    def test_account_a_preparation_activity_uses_own_session_before_public_binding(self):
        self.check_session_activity('A',preparing=True)
    def check_session_activity(self,account,preparing=False):
        page,_=self.enroll(account=account)
        if preparing:
            with closing(self.h.state.connect()) as db:
                db.execute("UPDATE managed_pages SET phase='receiver_enrolled' WHERE page_id=?",(page,));db.commit()
        path=self.f.root/'.local'/'codex-web-bridge'/'mcp-activity.jsonl'
        path.parent.mkdir(parents=True,exist_ok=True)
        now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        def event(session,call):
            return {'at':now,'callId':call,'tool':'read_files','event':'mcp_call_finished',
                    'route':'webcodex','sessionHash':hashlib.sha256(session.encode()).hexdigest(),
                    'httpStatus':200,'applicationSuccess':True,'arguments':{'path':'private.txt'}}
        own='8a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        foreign='0a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        path.write_text(json.dumps(event(self.sessions[page],own))+'\n'+
                        json.dumps(event('wc_sess_other',foreign))+'\n',encoding='utf-8')
        result=self.m.browser('session-activity',{'page_id':page})
        self.assertEqual(result['scope'],'bound_session_argument')
        self.assertEqual([x['callId'] for x in result['events']],[own])
        self.assertNotIn(self.sessions[page],json.dumps(result))
        self.assertNotIn('private.txt',json.dumps(result))
        self.assertEqual(self.m.browser('view',{'page_id':page})['page_id'],page)
    def test_preview_is_actual_enrollment_template_without_creating_identity_or_send(self):
        instructions='Read handoff and independently examine alternatives.'
        for account in ('A','B'):
            preview=self.m.browser('prompt-preview',{'page_id':'preview-'+account,'root':str(self.f.root),'account':account,'instructions':instructions})
            self.assertEqual(preview['model_sends'],0)
            self.assertEqual(self.m.browser('list',{})['pages'],[])
            text=''.join(block['text'] for block in preview['blocks'])
            self.assertIn('@Local-MCP'+('-B' if account=='B' else '')+'\n',text)
            self.assertEqual(text.count(user_authorization()),0)
            self.assertIn(instructions,text)
        page,reserved=self.reserve(account='A',first_turn_instructions=instructions,first_turn_mode='task_v1')
        with closing(self.h.state.connect()) as db:
            row=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page,)).fetchone()
        actual=reserved['bootstrap_text']
        actual=re.sub(r'clwm_[A-Za-z0-9_-]{43}','<发送时生成>',actual)
        actual=actual.replace('--store-id '+self.h.state.id,'--store-id <发送时填入>')
        actual=actual.replace('--target '+row['target_id'],'--target <发送时填入>')
        preview=self.m.browser('prompt-preview',{'page_id':'never-reserved','root':str(self.f.root),'account':'A','instructions':instructions})
        self.assertEqual(actual,''.join(block['text'] for block in preview['blocks']))
        saved=self.m.browser('prompt-preview',{'page_id':page,'instructions':'THIS WAS NOT SENT'})
        self.assertEqual(saved['source'],'saved_enrollment_message')
        self.assertIn(instructions,saved['blocks'][0]['text'])
        self.assertNotIn('THIS WAS NOT SENT',saved['blocks'][0]['text'])
        self.assertNotRegex(saved['blocks'][0]['text'],r'clwm_[A-Za-z0-9_-]{43}')
        self.assertNotIn(self.h.state.id,saved['blocks'][0]['text'])
    def test_full_project_scope_is_explicit_and_still_conflicts_with_shared_writers(self):
        page,_=self.enroll(access='write',write_paths=['.'])
        reader,_=self.enroll()
        rows={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        with closing(self.h.state.connect()) as db:
            scope=self.h.team.scopes.scope(db,rows[page]['thread_id'])
            other=self.h.team.scopes.scope(db,rows[reader]['thread_id'])
        self.assertEqual(json.loads(scope['write_paths']),['.'])
        self.assertTrue(self.h.team.scopes.conflict(scope,other))
        for access,paths in [('read',['.']),('write',['.','notes']),('write',['./']),('write',['../']),('write',[])]:
            with self.subTest(access=access,paths=paths),self.assertRaises(HarnessError):self.reserve(access=access,write_paths=paths)
    def test_repair_to_full_project_enrolls_original_session_and_preserves_pause(self):
        page,r=self.reserve();self.sessions[page]='wc_sess_'+uuid.uuid4().hex
        self.m.browser('bootstrap',{'page_id':page,'state':'sending'});self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        self.m.browser('page-issue',{'page_id':page,'kind':'bootstrap_receipt_missing','detail':'original error'})
        self.m.browser('configure-intake',{'page_id':page,'access':'write','write_paths':['.'],'expected_access':'read','expected_write_paths':[]})
        reply=self.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0],'project':'own-project','root':str(self.f.root)})
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/original','public_text':reply['browser_marker']})
        row=self.m.browser('list',{})['pages'][0]
        self.assertEqual(row['phase'],'bound');self.assertTrue(row['paused'])
        self.assertIsNone(row['attention'])
        self.assertEqual(row['bootstrap_state'],'sent');self.assertEqual(row['bootstrap_text'],r['bootstrap_text'])
        self.assertEqual(row['write_paths'],['.']);self.assertTrue(row['intake']['tool_receipt'])
    def test_failed_enrollment_audits_local_rejection_without_binding_or_replay(self):
        page,r=self.reserve();self.sessions[page]='wc_sess_'+uuid.uuid4().hex
        payload={'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0],'project':'own-project','root':str(self.f.root)}
        # Represent a legacy record that the old UI admitted with no write paths.
        with closing(self.h.state.connect()) as db:
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0]);settings['access']='write'
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),page));db.commit()
        for _ in range(2):
            with self.assertRaisesRegex(HarnessError,'team_write_paths_required'):self.private(page,'enroll',payload,key='same-failed-enrollment')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_intake_rejections').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_receipts WHERE actor=?',(page,)).fetchone()[0],0)
            self.assertIsNone(db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0])
            self.assertNotIn(payload['ticket'],str(list(db.execute('SELECT * FROM managed_intake_rejections'))))
        row=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==page)
        self.assertEqual(row['intake']['local_rejection']['code'],'team_write_paths_required')
        self.assertEqual(row['intake']['configuration_error'],'team_write_paths_required')
    def test_public_intake_reports_update_while_paused_without_authorizing_recovery(self):
        page,_=self.reserve();self.m.browser('bootstrap',{'page_id':page,'state':'sending'});self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        self.m.browser('page-issue',{'page_id':page,'kind':'bootstrap_receipt_missing','detail':'first error'})
        p={'page_id':page,'url':'https://chatgpt.com/c/original','source_hash':'a'*64,'public_text':'first reply'}
        self.m.browser('intake-observed',p)
        latest={**p,'source_hash':'b'*64,'public_text':'平台安全检查拦截 clwm_secret wc_sess_own CLW-MANAGED:fake'}
        self.m.browser('intake-observed',latest)
        self.assertFalse(self.m.browser('intake-observed',latest)['changed'])
        row=self.m.browser('list',{})['pages'][0]
        self.assertEqual(row['attention'],'first error');self.assertTrue(row['paused']);self.assertEqual(row['phase'],'reserved')
        self.assertEqual(row['bootstrap_state'],'sent');self.assertFalse(row['intake']['tool_receipt'])
        self.assertIsNone(row['intake']['local_rejection'])
        reply=row['intake']['latest_public_reply']['public_text']
        self.assertIn('平台安全检查',reply);self.assertNotIn('clwm_',reply);self.assertNotIn('wc_sess_',reply);self.assertNotIn('CLW-MANAGED:',reply)
        with self.assertRaises(HarnessError):self.m.browser('intake-observed',{**p,'url':'https://example.com/c/other'})
    def test_user_can_fix_unbound_scope_without_resetting_original_send_or_pause(self):
        page,_=self.reserve();change={'page_id':page,'access':'write','write_paths':['notes'],'expected_access':'read','expected_write_paths':[]}
        with self.assertRaises(HarnessError):self.m.browser('configure-intake',change)
        self.m.browser('bootstrap',{'page_id':page,'state':'sending'});self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        self.m.browser('page-issue',{'page_id':page,'kind':'bootstrap_receipt_missing','detail':'original platform report'})
        before=self.m.browser('list',{})['pages'][0]
        with self.assertRaises(HarnessError):self.m.browser('configure-intake',{**change,'write_paths':[]})
        result=self.m.browser('configure-intake',change);self.assertFalse(result['send_replayed'])
        after=self.m.browser('list',{})['pages'][0]
        for key in ('bootstrap_state','bootstrap_text','phase','thread_id','paused','attention','model','effort'):self.assertEqual(before[key],after[key])
        self.assertEqual(after['write_paths'],['notes']);self.assertEqual(after['access'],'write')
        with self.assertRaisesRegex(HarnessError,'managed_intake_settings_changed'):self.m.browser('configure-intake',change)
        bound,_=self.enroll()
        with self.assertRaises(HarnessError):self.m.browser('configure-intake',{**change,'page_id':bound})
    def test_configured_pro_model_and_private_transport(self):
        page,r=self.enroll()
        with self.assertRaises(HarnessError):self.h.control.wire('clw.managed-browser.v1',None,{'action':'capabilities'})
        self.assertEqual(self.wire(page,'pulse')['state'],'idle_or_old_request_not_adopted')
        data={**PAGE,'model_label':'GPT-5.6 Sol','effort_label':'最高'}
        self.assertEqual(self.wire(page,'pulse',page=data)['state'],'page_not_safe_or_model_mismatch')
    def test_pro_first_research_reaches_bootstrap_while_bare_enrollment_is_rejected(self):
        pro={'model':'GPT-6 · 最新','effort':'Pro'}
        page,_=self.reserve(model=pro['model'],effort='Pro',model_selection=pro,
                            first_turn_instructions='Read the evidence and complete an independent research plan.')
        self.m.browser('page-issue',{'page_id':page,'kind':'model_unavailable','detail':'接入和简单准备不能使用 Pro。旧本地规则。'})
        before=next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==page)
        self.assertTrue(before['paused'])
        self.m.browser('pause',{'page_id':page,'paused':False})
        ready=self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':pro})
        self.assertTrue(ready['verified'])
        self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
        with self.assertRaisesRegex(HarnessError,'managed_bootstrap_no_blind_retry'):
            self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        empty,_=self.reserve(model=pro['model'],effort='Pro',model_selection=pro)
        with self.assertRaisesRegex(HarnessError,'managed_pro_enrollment_not_allowed'):
            self.m.browser('bootstrap-model-ready',{'page_id':empty,'model_selection':pro})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[page]['bootstrap_state'],'sent')
        self.assertEqual(rows[page]['bootstrap_text'],before['bootstrap_text'])
        self.assertEqual(rows[page]['page_id'],before['page_id'])
        self.assertEqual(rows[empty]['bootstrap_state'],'pending')

    def test_new_task_preview_without_directory_does_not_create_page(self):
        before=self.m.browser('list',{})['pages']
        result=self.m.browser('prompt-preview',{'page_id':'new-task-preview','root':'','account':'A','instructions':'Research plan'})
        self.assertEqual(result['model_sends'],0)
        self.assertIn('<发送时创建的独立工作区>', ''.join(b['text'] for b in result['blocks']))
        self.assertEqual(before,self.m.browser('list',{})['pages'])

    def test_pro_controller_preparation_does_not_become_worker_enrollment(self):
        pro={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新'],
             'slider':{'min':0,'max':4,'value':4},'description':'6 Pro'}
        parent,binding=self.enroll(model=pro['model'],effort='Pro',model_selection=pro,
                             first_turn_instructions='Read evidence and prepare the complete research plan.')
        self.f.command(binding['thread_id'],'message.send',{'text':'Complete the research work package'})
        observation={**PAGE,'model_label':pro['model'],'effort_label':pro['effort']}
        offer=self.wire(parent,'pulse',page=observation)
        self.wire(parent,'dispatch',attempt_id=offer['attempt_id'],page=observation)
        self.wire(parent,'sent',attempt_id=offer['attempt_id'],page={**observation,'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        child,reserved=self.reserve(parent)
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        setup=rows[child]['bootstrap_model_selection']
        self.assertEqual(setup,{'model':pro['model'],'selection':['最新'],'effort':'极高'})
        self.assertEqual(rows[parent]['bootstrap_model_selection'],pro)
        self.assertEqual(rows[child]['effort'],'pro');self.assertTrue(rows[child]['work_model_pending'])
        self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':setup})
        self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':child,'state':'sent'})
        self.sessions[child]='wc_sess_'+uuid.uuid4().hex
        result=self.private(child,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',reserved['bootstrap_text'])[0],
                                          'project':'own-project','root':str(self.f.root)})
        self.m.browser('bind',{'page_id':child,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':result['browser_marker']})
        self.m.browser('work-model-ready',{'page_id':child,'model_selection':pro})
        row=next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==child)
        self.assertEqual(row['effort'],'pro');self.assertFalse(row['work_model_pending'])
        self.assertEqual(row['bootstrap_state'],'sent')
        with self.assertRaisesRegex(HarnessError,'managed_bootstrap_no_blind_retry'):
            self.m.browser('bootstrap',{'page_id':child,'state':'sending'})

    def test_resume_repairs_only_unsent_legacy_worker_pro_setup_and_keeps_original(self):
        pro={'model':'GPT-6 · 最新','effort':'Pro','selection':['最新'],'slider':{'value':4}}
        parent,_=self.enroll(model=pro['model'],effort='Pro',model_selection=pro,first_turn_instructions='Research plan')
        for bootstrap_state,kind,repair in [('pending','preparation_required',True),('sent','preparation_required',False),
                                            ('unknown','preparation_required',False),('pending','bootstrap_failed',False)]:
            with self.subTest(state=bootstrap_state,kind=kind):
                child,_=self.reserve(parent)
                # Reproduce records written by the old worker inheritance code.
                with closing(self.h.state.connect()) as db:
                    settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(child,)).fetchone()[0])
                    settings.update(bootstrap_model_selection=pro,work_model_pending=False)
                    db.execute('UPDATE managed_pages SET settings=?,bootstrap_state=? WHERE page_id=?',(json.dumps(settings),bootstrap_state,child));db.commit()
                self.m.browser('page-issue',{'page_id':child,'kind':kind,'detail':'original local or platform failure'})
                before=next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==child)
                self.assertTrue(before['paused']);self.assertEqual(before['bootstrap_model_selection'],pro)
                self.m.browser('pause',{'page_id':child,'paused':False})
                after=next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==child)
                for field in ('page_id','target_id','parent_target','bootstrap_text','bootstrap_state','phase','model','effort','thread_id'):
                    self.assertEqual(before[field],after[field])
                self.assertEqual(after['work_model_pending'],repair)
                self.assertEqual(after['bootstrap_model_selection']['effort'],'极高' if repair else 'Pro')
                with closing(self.h.state.connect()) as db:
                    saved=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(child,)).fetchone()[0])
                self.assertEqual('enrollment_repair' in saved,repair)
                if repair:self.assertEqual(saved['enrollment_repair']['previous_issue']['detail'],'original local or platform failure')

    def test_extra_high_enrollment_survives_pro_adoption_and_worker_waits_for_work_model(self):
        initial={'model':'GPT-5.6 · 最新','effort':'极高','selection':['最新'],'slider':{'min':0,'max':4,'value':3}}
        pro={**initial,'effort':'Pro','slider':{'min':0,'max':4,'value':4}}
        page,b=self.enroll(model=initial['model'],effort=initial['effort'],model_selection=initial)
        self.m.browser('configure-model',{'page_id':page,'model':pro['model'],'effort':pro['effort'],'model_selection':pro,'expected_model':initial['model'],'expected_effort':initial['effort']})
        child,r=self.reserve(page)
        rows={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[page]['bootstrap_model_selection'],initial)
        self.assertEqual(rows[child]['effort'],'pro');self.assertTrue(rows[child]['work_model_pending'])
        with self.assertRaises(HarnessError):self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':pro})
        self.m.browser('bootstrap-model-ready',{'page_id':child,'model_selection':initial})
        self.sessions[child]='wc_sess_'+uuid.uuid4().hex
        result=self.private(child,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0],'project':'own-project','root':str(self.f.root)})
        self.m.browser('bind',{'page_id':child,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':result['browser_marker']})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(self.m.pages_ready(db,[child])['state'],'waiting_events')
        listed=next(x for x in self.private(page,'pages',{})['pages'] if x['page_id']==child)
        self.assertTrue(listed['work_model_pending']);self.assertNotIn('settings',listed)
        with self.assertRaises(HarnessError):self.wire(child,'pulse')
        with self.assertRaises(HarnessError):self.m.browser('work-model-ready',{'page_id':child,'model_selection':initial})
        confirmed=self.m.browser('work-model-ready',{'page_id':child,'model_selection':pro})
        self.assertEqual(confirmed['model_sends'],0)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(self.m.pages_ready(db,[child])['state'],'pages_ready')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],0)
        self.assertEqual(self.wire(child,'pulse',page={**PAGE,'model_label':pro['model'],'effort_label':pro['effort']})['state'],'idle_or_old_request_not_adopted')
    def test_no_worker_count_cap(self):
        parent,_=self.enroll()
        for _ in range(18):self.enroll(parent)
        self.assertEqual(len(self.private(parent,'pages',{})['pages']),19)
    def test_account_is_selected_once_and_inherited_by_workers(self):
        page,r=self.reserve(account='A')
        self.assertIn('@Local-MCP\n',r['bootstrap_text'])
        self.assertNotIn('@Local-MCP-A\n',r['bootstrap_text'])
        self.assertNotIn('@Local-MCP-B\n',r['bootstrap_text'])
        self.sessions[page]='wc_sess_'+uuid.uuid4().hex
        receiver=self.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0],'project':'own-project','root':str(self.f.root)})
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':receiver['browser_marker']})
        child,created=self.reserve(page)
        self.assertIn('@Local-MCP\n',created['bootstrap_text'])
        rows={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[child]['account'],'A')
        self.assertEqual(rows[page]['account'],'A')
    def test_work_and_snapshot_pagination_do_not_drop_later_workers(self):
        parent,request,offer,context=self.start_browser_turn();run=context['run']['id']
        children=[self.enroll(parent) for _ in range(70)]
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=parent)
            assigned=[]
            for child,b in children:
                reply=self.h.team.assign(db,actor,{'run_id':run,'claim_id':context['request']['claim_id'],'target':child,'text':'Independent read-only review','depends_on':[],'resources':[]},str(uuid.uuid4()))
                assigned.append(reply['request_id'])
                self.h.team.checkpoint(db,self.h.binding(db,target=child),{'run_id':run,'expected_version':0,'summary':'public snapshot','references':[],'basis_seq':0})
            work=[];snapshots=[];w=s=0
            for _ in range(10):
                result=self.h.team.context(db,actor,{'run_id':run,'after_seq':0,'work_after':w,'snapshots_after':s})
                work.extend(x['request_id'] for x in result['work']);snapshots.extend(x['thread_id'] for x in result['snapshots'])
                w=result['next_work_after'];s=result['next_snapshots_after']
                if not result['work_has_more'] and not result['snapshots_has_more']:break
            self.assertEqual(work,assigned)
            self.assertEqual(len(set(snapshots)),70)
            self.assertEqual(len(snapshots),70)
            db.commit()
    def test_foreground_owned_renderer_is_allowed_but_user_draft_is_not(self):
        page,b=self.enroll();self.f.command(b['thread_id'],'message.send',{'text':'original goal'})
        active={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','focused':True}
        self.assertEqual(self.wire(page,'pulse',page={**active,'draft':True})['state'],'page_not_safe_or_model_mismatch')
        self.assertEqual(self.wire(page,'pulse',page={**active,'composing':True})['state'],'page_not_safe_or_model_mismatch')
        offer=self.wire(page,'pulse',page=active);self.assertEqual(offer['state'],'offer')
        self.wire(page,'dispatch',page=active,attempt_id=offer['attempt_id'])
        result=self.wire(page,'sent',page={**active,'user_hash':'b'*64,'generating':True},attempt_id=offer['attempt_id'],assistant_before_hash='c'*64)
        self.assertEqual(result['state'],'browser_result_pending')
        self.assertTrue(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==page)['active_work'])
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.assertFalse(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==page)['active_work'])
    def test_explicit_legacy_hold_keeps_original_claim_and_allows_new_managed_work(self):
        self.f.join();request=self.f.start();self.f.delegate(request);self.f.yield_parent(request)
        page,b=self.enroll()
        with closing(self.h.state.connect()) as db:
            before=[tuple(r) for r in db.execute('SELECT id,phase,claim_id,cancel_requested FROM host_requests ORDER BY id')]
        rejected=self.f.command(b['thread_id'],'message.send',{'text':'new review'})
        self.assertEqual(rejected['code'],'workspace_busy_or_unreconciled')
        held=self.m.browser('hold-legacy',{'targets':['main','child-a']})
        self.assertTrue(held['original_requests_and_claims_preserved'])
        with closing(self.h.state.connect()) as db:
            after=[tuple(r) for r in db.execute('SELECT id,phase,claim_id,cancel_requested FROM host_requests ORDER BY id')]
            self.assertEqual(before,after)
            self.assertTrue(self.m.held_legacy(db,self.f.parent['id']))
        accepted=self.f.command(b['thread_id'],'message.send',{'text':'new review'})
        self.assertEqual(accepted['state'],'queued_for_web_host')
    def test_history_hold_refuses_a_processing_or_managed_execution(self):
        self.f.start()
        with self.assertRaises(HarnessError):self.m.browser('hold-legacy',{'targets':['main']})
        page,_=self.enroll()
        with self.assertRaises(HarnessError):self.m.browser('hold-legacy',{'targets':[page]})
    def test_send_receipt_reopens_original_and_counts_initial_send(self):
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'研究目标'})['request_id']
        offer=self.wire(page,'pulse');self.assertEqual(offer['request_id'],request)
        grant=self.wire(page,'dispatch',attempt_id=offer['attempt_id']);self.assertTrue(grant['dispatch'])
        self.assertEqual(grant['prompt'].count(user_authorization().strip()),0)
        self.assertEqual(grant['prompt'].count(WORK_PACKAGE_GUIDANCE),1)
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True}
        receipt=self.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
        self.assertEqual(receipt['state'],'browser_result_pending')
        context=self.private(page,'context',{})
        self.assertEqual(context['request']['phase'],'processing');self.assertEqual(context['run']['dispatches'],1)
        self.assertEqual(context['run']['max_parallel'],0)
        self.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
        self.assertEqual(self.private(page,'context',{})['run']['dispatches'],1)
    def test_unknown_bootstrap_cannot_be_resent(self):
        page,_=self.reserve();self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
        self.m.browser('bootstrap',{'page_id':page,'state':'unknown'})
        with self.assertRaises(HarnessError):self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
    def test_explicit_pause_survives_reconnect(self):
        page,_=self.enroll();self.m.browser('pause',{'page_id':page,'paused':True})
        with self.assertRaises(HarnessError):self.wire(page,'pulse')
        self.assertEqual(self.m.browser('list',{})['pages'][0]['paused'],1)
    def test_old_initial_offer_resumes_once_without_replacing_request_or_attempt(self):
        now=[1000.];self.h.clock=lambda:now[0]
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'initial queued goal'})['request_id']
        offer=self.wire(page,'pulse')
        self.m.browser('pause',{'page_id':page,'paused':True});now[0]+=3600
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        renewed=self.wire(page,'pulse');self.assertEqual(renewed['attempt_id'],offer['attempt_id'])
        self.assertEqual(renewed['request_id'],request)
        with closing(self.h.state.connect()) as db:
            self.assertIsNone(self.h.team.run_for_request(db,request))
            self.assertIsNone(db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0])
        self.assertTrue(self.wire(page,'dispatch',attempt_id=offer['attempt_id'])['dispatch'])
        now[0]+=3600
        state=self.wire(page,'pulse');self.assertEqual(state['state'],'original_attempt_requires_reconciliation')
        self.assertEqual(state['attempt_id'],offer['attempt_id'])
        with self.assertRaises(HarnessError):self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
    def test_parent_pause_is_inherited_without_erasing_individual_child_pause(self):
        parent,_=self.enroll();child,_=self.enroll(parent)
        self.m.browser('pause',{'page_id':parent,'paused':True})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertTrue(rows[child]['paused']);self.assertFalse(rows[child]['own_paused'])
        with self.assertRaises(HarnessError):self.m.browser('pause',{'page_id':child,'paused':False})
        self.m.browser('pause',{'page_id':child,'paused':True})
        self.m.browser('pause',{'page_id':parent,'paused':False})
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertFalse(rows[parent]['paused']);self.assertTrue(rows[child]['paused'])
    def start_browser_turn(self):
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'可核对的工作目标'})['request_id']
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True}
        self.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
        return page,request,offer,self.private(page,'context',{})
    def test_managed_turn_admits_disjoint_native_git_work_before_send(self):
        from native_work_admission import request as native_request
        page,b=self.enroll(access='write',write_paths=['.'])
        other_dir=tempfile.TemporaryDirectory(prefix='clw-managed-other-git-');self.addCleanup(other_dir.cleanup)
        other=Path(other_dir.name)
        subprocess.run(['git','-C',str(other),'init','-q'],check=True,capture_output=True,timeout=8)
        result=other/'result';result.mkdir()
        native=native_request(self.h.state.path,workspace=str(other),result_path=str(result),owner_pid=os.getpid())
        self.assertEqual(native['state'],'reserved')
        original=self.f.command(b['thread_id'],'message.send',{'text':'独立目录的可核对工作'})['request_id']
        offer=self.wire(page,'pulse');self.assertEqual(offer['state'],'offer')
        dispatched=self.wire(page,'dispatch',attempt_id=offer['attempt_id']);self.assertTrue(dispatched['dispatch'])
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True}
        self.wire(page,'sent',attempt_id=offer['attempt_id'],page=sent,assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            run=self.h.team.run_for_request(db,original)
            self.assertIsNotNone(run)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases WHERE request_id=?',(original,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT state FROM native_work_claims WHERE claim_id=?',(native['claim_id'],)).fetchone()[0],'reserved')
    def start_partial_text_worker(self):
        master,b=self.enroll(collaboration_protocol='text_v1')
        worker,_=self.enroll(master)
        parent_request=self.f.command(b['thread_id'],'message.send',{'text':'核对原始证据并整合'})['request_id']
        master_offer=self.wire(master,'pulse')
        self.wire(master,'dispatch',attempt_id=master_offer['attempt_id'])
        self.wire(master,'sent',attempt_id=master_offer['attempt_id'],
                  page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                        'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=master)
            run=self.h.team.run_for_request(db,parent_request)
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(parent_request,)).fetchone()[0]
            assigned=self.h.team.assign(db,actor,{'run_id':run['id'],'claim_id':claim,
                'target':worker,'text':'只读核对证据','depends_on':[],'resources':[]},'partial-work')
            db.commit()
        offer=self.wire(worker,'pulse')
        dispatch=self.wire(worker,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('prepare',{'page_id':worker,'attempt_id':offer['attempt_id'],
            'assistant_before_hash':'c'*64,
            'prompt_hash':hashlib.sha256(dispatch['prompt'].encode('utf-8')).hexdigest()})
        page=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==worker)
        observation={'page_id':worker,'attempt_id':offer['attempt_id'],'url':page['url'],
            'previous_user_hash':'a'*64,'user_hash':'b'*64,
            'assistant_before_hash':'c'*64,'assistant_turn_hash':'d'*64,
            'user_text':dispatch['prompt'].split('\n',1)[0],
            'assistant_text':'I can help with that request.',
            'user_text_complete':True,'complete':True,'history_at_latest':True,
            'generating':False,'draft':False,'composing':False}
        return master,worker,run['id'],assigned['request_id'],dispatch['prompt'],observation
    def test_partial_public_send_preserves_original_and_wakes_controller_once(self):
        master,worker,run_id,request,prompt,observation=self.start_partial_text_worker()
        attempt=observation['attempt_id']
        prepared=self.m.browser('prepared',{'page_id':worker,'attempt_id':attempt})
        self.assertEqual(prepared['previous_user_hash'],observation['previous_user_hash'])
        self.assertEqual(prepared['prompt_hash'],hashlib.sha256(prompt.encode('utf-8')).hexdigest())
        with closing(self.h.state.connect()) as db:
            before=db.execute('SELECT COUNT(*) FROM host_team_signals WHERE run_id=? AND kind=?',
                              (run_id,'host_turn_attention')).fetchone()[0]
            budget=db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run_id,)).fetchone()[0]
        result=self.m.browser('partial-public-send',observation)
        self.assertEqual(result['state'],'partial_or_foreign_public_send')
        self.assertTrue(result['attention_only'])
        self.assertTrue(result['budget_dispatch_recorded'])
        self.assertEqual(result['request_phase'],'queued')
        artifact=Path(result['artifact']['path'])
        self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(),result['artifact']['sha256'])
        saved=json.loads(artifact.read_text(encoding='utf-8'))
        self.assertEqual(saved['observation'],observation)
        replay=self.m.browser('partial-public-send',observation)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['artifact'],result['artifact'])
        from harness_managed import ManagedPages
        self.assertTrue(ManagedPages(self.h).browser('partial-public-send',observation)['replayed'])
        with closing(self.h.state.connect()) as db:
            original=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual((original['phase'],original['claim_id']),('queued',None))
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(attempt,)).fetchone()[0],'dispatching')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',(attempt,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run_id,)).fetchone()[0],budget)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_signals WHERE run_id=? AND kind=?',
                                        (run_id,'host_turn_attention')).fetchone()[0],before+1)
            self.assertTrue(self.h.team.journal.wait_ready(db,dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run_id,)).fetchone()),'all',0))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE id=? AND source=?',
                                        (attempt+'-partial','public_dom_partial_send')).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases WHERE request_id=?',
                                        (request,)).fetchone()[0],1)
            actor=self.h.binding(db,target=master)
            seen=self.h.team.journal.result(db,actor,{'run_id':run_id,'request_id':request})
            self.assertIsNone(seen['reply'])
            self.assertEqual(seen['attention']['classification'],'partial_or_foreign_public_send')
            self.assertFalse(seen['attention']['task_completed'])
            self.assertEqual(seen['artifacts'][0]['source'],'public_dom_partial_send')
            report,_,_=self.m.text._results(db,actor,dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run_id,)).fetchone()))
            self.assertIn('partial_or_foreign_public_send',report)
            self.assertIn('尚无已确认公开答复',report)
        self.assertTrue(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==worker)['paused'])
        with self.assertRaises(HarnessError):self.wire(worker,'dispatch',attempt_id=attempt)
        self.m.browser('pause',{'page_id':worker,'paused':False,'expected_request_id':request})
        with self.assertRaises(HarnessError) as no_late_sent:
            self.wire(worker,'sent',attempt_id=attempt,
                      page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                            'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        self.assertEqual(no_late_sent.exception.code,'managed_partial_public_attempt_unresolved')
        with self.assertRaises(HarnessError):self.private(worker,'context',{'attempt_id':attempt})
        with self.assertRaises(HarnessError):self.m.browser('artifact',{
            'page_id':worker,'attempt_id':attempt,'text':'not a complete worker result',
            'assistant_turn_hash':'d'*64})
    def test_partial_public_send_requires_exact_unresolved_public_turn(self):
        master,worker,run_id,request,prompt,observation=self.start_partial_text_worker()
        cases=[{'url':'https://chatgpt.com/c/foreign'},
               {'previous_user_hash':'f'*64},{'user_hash':'a'*64},
               {'assistant_before_hash':'f'*64},{'assistant_turn_hash':'c'*64},
               {'user_text_complete':False},{'complete':False},
               {'history_at_latest':False},{'generating':True},
               {'draft':True},{'composing':True},
               {'user_text':prompt},
               {'user_text':observation['user_text']+'\n[CLW:'+observation['attempt_id']+']'}]
        for changed in cases:
            with self.subTest(changed=changed),self.assertRaises(HarnessError):
                self.m.browser('partial-public-send',{**observation,**changed})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_partial_public_sends').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_attention WHERE request_id=?',(request,)).fetchone()[0],0)
        first=self.m.browser('partial-public-send',observation)
        with self.assertRaises(HarnessError) as conflict:
            self.m.browser('partial-public-send',{**observation,'assistant_text':'different public reply'})
        self.assertEqual(conflict.exception.code,'managed_partial_public_conflict')
        self.assertEqual(self.m.browser('partial-public-send',observation)['artifact'],first['artifact'])
    def test_partial_public_send_cannot_reclassify_a_claimed_browser_turn(self):
        master,worker,run_id,request,prompt,observation=self.start_partial_text_worker()
        self.wire(worker,'sent',attempt_id=observation['attempt_id'],
                  page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                        'user_hash':observation['user_hash'],'generating':True},
                  assistant_before_hash=observation['assistant_before_hash'])
        with self.assertRaises(HarnessError):self.m.browser('partial-public-send',observation)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_partial_public_sends').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_attention WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_browser_receipts WHERE attempt_id=?',
                                        (observation['attempt_id'],)).fetchone()[0],1)
    def partial_retirement_payload(self,worker,request,observation):
        from harness_state import canonical
        return {'page_id':worker,'request_id':request,'attempt_id':observation['attempt_id'],
            'observation_hash':hashlib.sha256(canonical(observation).encode()).hexdigest(),
            'url':observation['url'],'user_hash':observation['user_hash'],
            'assistant_turn_hash':observation['assistant_turn_hash'],
            'user_text':observation['user_text'],'assistant_text':observation['assistant_text'],
            'reason':'Reviewed exact partial public turn; no worker result',
            'confirm':True,'complete':True,'history_at_latest':True,
            'generating':False,'draft':False,'composing':False}
    def test_operator_retires_exact_partial_read_only_turn_without_replay(self):
        master,worker,run_id,request,_,observation=self.start_partial_text_worker()
        self.m.browser('partial-public-send',observation)
        payload=self.partial_retirement_payload(worker,request,observation)
        visible=self.m.browser('view',{'page_id':worker})
        self.assertEqual(visible['partial_public_send']['request_id'],request)
        self.assertEqual(visible['partial_public_send']['observation_hash'],payload['observation_hash'])
        with patch('native_work_admission.zero_local_jobs',return_value=True) as jobs:
            result=self.m.browser('retire-partial',payload)
            again=self.m.browser('retire-partial',payload)
        self.assertEqual(jobs.call_count,2)
        self.assertEqual(result['status'],'blocked')
        self.assertTrue(result['public_send_observed'])
        self.assertFalse(result['worker_reported_success'])
        self.assertFalse(result['old_request_retried'])
        self.assertTrue(result['worker_available_for_new_work'])
        self.assertTrue(again['replayed'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'blocked')
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(observation['attempt_id'],)).fetchone()[0],'partial_retired')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_replies WHERE request_id=?',(request,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_partial_public_sends WHERE attempt_id=?',(observation['attempt_id'],)).fetchone()[0],1)
            actor=self.h.binding(db,target=master)
            seen=self.h.team.journal.result(db,actor,{'run_id':run_id,'request_id':request})
            self.assertIsNone(seen['attention'])
            self.assertEqual(seen['resolution']['attempt_id'],observation['attempt_id'])
        self.assertFalse(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==worker)['paused'])
        self.assertIsNone(self.m.browser('view',{'page_id':worker})['partial_public_send'])
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=master)
            parent=db.execute('SELECT controller_request FROM host_runs WHERE id=?',(run_id,)).fetchone()[0]
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(parent,)).fetchone()[0]
            fresh=self.h.team.assign(db,actor,{'run_id':run_id,'claim_id':claim,
                'target':worker,'text':'New read-only evidence check after old partial Send was retired',
                'depends_on':[],'resources':[]},'fresh-after-retired-partial')
            db.commit()
        self.assertNotEqual(fresh['request_id'],request)
        self.assertEqual(self.wire(worker,'pulse')['request_id'],fresh['request_id'])
    def test_partial_retirement_fails_closed_on_changed_public_turn_or_execution(self):
        master,worker,run_id,request,_,observation=self.start_partial_text_worker()
        self.m.browser('partial-public-send',observation)
        payload=self.partial_retirement_payload(worker,request,observation)
        with patch('native_work_admission.zero_local_jobs',return_value=True):
            for key,value in [('user_hash','e'*64),('assistant_turn_hash','f'*64),
                              ('user_text','different'),('assistant_text','different public reply'),
                              ('history_at_latest',False),('draft',True)]:
                with self.subTest(key=key),self.assertRaises(HarnessError):
                    self.m.browser('retire-partial',{**payload,key:value})
            with closing(self.h.state.connect()) as db:
                db.execute("UPDATE host_team_leases SET access='write' WHERE request_id=?",(request,));db.commit()
            with self.assertRaisesRegex(HarnessError,'managed_partial_retirement_execution_not_quiescent'):
                self.m.browser('retire-partial',payload)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'queued')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_partial_retirements').fetchone()[0],0)
    def test_partial_retirement_requires_clear_local_jobs(self):
        master,worker,run_id,request,_,observation=self.start_partial_text_worker()
        self.m.browser('partial-public-send',observation)
        payload=self.partial_retirement_payload(worker,request,observation)
        with patch('native_work_admission.zero_local_jobs',return_value=False):
            with self.assertRaisesRegex(HarnessError,'managed_partial_retirement_external_jobs_not_idle'):
                self.m.browser('retire-partial',payload)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'queued')
    def test_text_controller_prompt_examples_match_the_parser(self):
        page,b=self.enroll(collaboration_protocol='text_v1')
        self.f.command(b['thread_id'],'message.send',{'text':'分配只读核验并整合结果'})
        offer=self.wire(page,'pulse')
        prompt=self.wire(page,'dispatch',attempt_id=offer['attempt_id'])['prompt']
        self.assertEqual(prompt.count(user_authorization().strip()),0)
        self.assertEqual(prompt.count(WORK_PACKAGE_GUIDANCE),1)
        self.assertIn('"version":1',prompt)
        self.assertIn('wait 无须填写',prompt)
        self.assertIn('完整首任务与接入合并',prompt)
        examples=[]
        for match in re.finditer(r'\{',prompt):
            try:value,_=json.JSONDecoder().raw_decode(prompt[match.start():])
            except ValueError:continue
            if isinstance(value,dict) and 'action' in value:examples.append(value)
        self.assertEqual({x['action'] for x in examples},{'dispatch','completed','needs_attention'})
        for value in examples:
            parsed=parse_controller_reply('```clw-plan-v1\n'+json.dumps(value)+'\n```')
            self.assertEqual(parsed['version'],1)
            if parsed['action']=='dispatch':
                self.assertEqual(set(parsed['workers'][0]),{'key','objective'})
                self.assertEqual(parsed['wait'],{'mode':'all','workers':['A']})
    def test_text_prompt_failure_after_delivery_insert_does_not_commit_send_grant(self):
        page,b=self.enroll(collaboration_protocol='text_v1')
        request=self.f.command(b['thread_id'],'message.send',{'text':'核对一份公开结果'})['request_id']
        offer=self.wire(page,'pulse')
        original_prompt=self.m.text.prompt
        def fail_after_delivery(db,*args):
            original_prompt(db,*args)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_text_deliveries WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],1)
            raise RuntimeError('injected pre-send prompt failure')
        with patch.object(self.m.text,'prompt',side_effect=fail_after_delivery):
            with self.assertRaisesRegex(RuntimeError,'injected pre-send prompt failure'):
                self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with closing(self.h.state.connect()) as db:
            attempt=db.execute('SELECT state,dispatched FROM control_attempts WHERE id=?',
                               (offer['attempt_id'],)).fetchone()
            self.assertEqual((attempt['state'],attempt['dispatched']),('offered',None))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_text_deliveries WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_dispatches WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='control_dispatch' AND json_extract(data,'$.attempt_id')=?",
                                        (offer['attempt_id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'queued')
        retry=self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.assertTrue(retry['dispatch']);self.assertIn('clw-plan-v1',retry['prompt'])
        self.assertEqual(self.m.browser('wire',{'page_id':page,'data':{'action':'finish',
                         'attempt_id':offer['attempt_id'],'result':'unknown'}})['state'],'unknown')
        with self.assertRaises(HarnessError):self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
    def test_text_worker_prompt_failure_does_not_spend_existing_run_budget(self):
        page,b=self.enroll(collaboration_protocol='text_v1')
        worker,_=self.enroll(page)
        request=self.f.command(b['thread_id'],'message.send',{'text':'分工核对公开成果'})['request_id']
        first=self.wire(page,'pulse')
        self.wire(page,'dispatch',attempt_id=first['attempt_id'])
        self.wire(page,'sent',attempt_id=first['attempt_id'],
                  page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                        'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        context=self.private(page,'context',{})
        run_id=context['run']['id']
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=page)
            self.h.team.assign(db,actor,{'run_id':run_id,'claim_id':context['request']['claim_id'],
                'target':worker,'text':'独立核对一项公开成果','depends_on':[],'resources':[]},str(uuid.uuid4()))
            db.commit()
        offer=self.wire(worker,'pulse')
        original_prompt=self.m.text.prompt
        def fail_after_delivery(db,*args):
            original_prompt(db,*args)
            raise RuntimeError('injected worker prompt failure')
        with patch.object(self.m.text,'prompt',side_effect=fail_after_delivery):
            with self.assertRaisesRegex(RuntimeError,'injected worker prompt failure'):
                self.wire(worker,'dispatch',attempt_id=offer['attempt_id'])
        with closing(self.h.state.connect()) as db:
            attempt=db.execute('SELECT state,dispatched FROM control_attempts WHERE id=?',
                               (offer['attempt_id'],)).fetchone()
            self.assertEqual((attempt['state'],attempt['dispatched']),('offered',None))
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run_id,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_dispatches WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_text_deliveries WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],0)
        self.assertTrue(self.wire(worker,'dispatch',attempt_id=offer['attempt_id'])['dispatch'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run_id,)).fetchone()[0],2)
    def test_text_collaboration_uses_original_run_for_two_workers_and_one_resume(self):
        master,b=self.enroll(collaboration_protocol='text_v1')
        worker_a,_=self.enroll(master)
        worker_b,_=self.enroll(master)
        pages={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertEqual({pages[x]['collaboration_protocol'] for x in (master,worker_a,worker_b)}, {'text_v1'})
        request=self.f.command(b['thread_id'],'message.send',{'text':'分工完成两份独立核验并整合'})['request_id']
        offer=self.wire(master,'pulse')
        dispatched=self.wire(master,'dispatch',attempt_id=offer['attempt_id'])
        self.assertIn('clw-plan-v1',dispatched['prompt'])
        with closing(self.h.state.connect()) as db:
            self.assertIsNone(db.execute('SELECT run_id FROM managed_text_deliveries WHERE attempt_id=?',
                                         (offer['attempt_id'],)).fetchone()[0])
        sent_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        self.wire(master,'sent',attempt_id=offer['attempt_id'],page={**sent_page,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            original=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            run=self.h.team.run_for_request(db,request)
        raw=('我将核验两份独立结果。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch',
            'workers':[{'key':'A','target':worker_a,'objective':'核验甲：保留公式 \\(x^2\\)'},
                       {'key':'B','target':worker_b,'objective':'核验乙：保留代码和链接'}],
            'resume':'读取两份原始成果后整合。'},ensure_ascii=False)+'\n```')
        self.m.browser('artifact',{'page_id':master,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
        first=self.wire(master,'result',attempt_id=offer['attempt_id'],page=sent_page,
                        assistant_turn_hash='d'*64,text=raw)
        self.assertEqual(first['state'],'yielded')
        self.assertTrue(self.wire(master,'result',attempt_id=offer['attempt_id'],page=sent_page,
                                  assistant_turn_hash='d'*64,text=raw)['replayed'])
        with closing(self.h.state.connect()) as db:
            q=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()
            self.assertEqual((q['phase'],q['claim_id']),('suspended',original['claim_id']))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',(run['id'],)).fetchone()[0],2)
        for i,worker in enumerate((worker_a,worker_b)):
            woffer=self.wire(worker,'pulse');self.assertEqual(woffer['state'],'offer')
            self.wire(worker,'dispatch',attempt_id=woffer['attempt_id'])
            self.wire(worker,'sent',attempt_id=woffer['attempt_id'],page={**sent_page,'generating':True},assistant_before_hash='c'*64)
            result='成果'+str(i)+'：\\[E=mc^2\\]\n```python\nprint("ok")\n```\nhttps://example.org/source'
            if i==0:result+='\n'+'完整推导。'*10000+'\n尾部反例及修正必须完整带回'
            self.m.browser('artifact',{'page_id':worker,'attempt_id':woffer['attempt_id'],'text':result,
                                       'assistant_turn_hash':('e' if i==0 else 'f')*64})
            with closing(self.h.state.connect()) as db:
                saved=db.execute('SELECT path,sha256 FROM managed_artifacts WHERE id=?',(woffer['attempt_id'],)).fetchone()
            transport_text=self.m.text._body(result,saved)
            self.assertEqual(self.wire(worker,'result',attempt_id=woffer['attempt_id'],page=sent_page,
                                       assistant_turn_hash=('e' if i==0 else 'f')*64,text=transport_text)['state'],'completed')
            if i==0:self.assertNotEqual(self.wire(master,'pulse',page=sent_page)['state'],'offer')
        next_offer=self.wire(master,'pulse',page=sent_page)
        self.assertEqual(next_offer['state'],'offer')
        prompt=self.wire(master,'dispatch',page=sent_page,attempt_id=next_offer['attempt_id'])['prompt']
        self.assertIn('成果0',prompt);self.assertIn('成果1',prompt);self.assertIn('读取两份原始成果后整合',prompt)
        self.assertIn('尾部反例及修正必须完整带回',prompt)
        self.assertNotIn('wait.workers 必须列出',prompt)
        self.wire(master,'sent',attempt_id=next_offer['attempt_id'],page={**sent_page,'user_hash':'a'*64,'generating':True},assistant_before_hash='d'*64)
        final='两份已整合。\n```clw-plan-v1\n{"version":1,"action":"completed","summary":"两份已整合"}\n```'
        self.m.browser('artifact',{'page_id':master,'attempt_id':next_offer['attempt_id'],'text':final,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(master,'result',attempt_id=next_offer['attempt_id'],page={**sent_page,'user_hash':'a'*64},
                                   assistant_turn_hash='e'*64,text=final)['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'completed')
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(run['id'],)).fetchone()[0],'closed')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads WHERE run_id=?',(run['id'],)).fetchone()[0],2)
    def test_text_plan_runs_first_tasks_in_enrollment_once_and_recovers_results(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        goal=self.f.command(b['thread_id'],'message.send',{'text':'并行完成两份只读证据，再整合'})['request_id']
        state={**PAGE,'model_label':model,'effort_label':effort}
        offer=self.wire(main,'pulse',page=state)
        self.wire(main,'dispatch',attempt_id=offer['attempt_id'],page=state)
        sent={**state,'user_hash':'b'*64}
        self.wire(main,'sent',attempt_id=offer['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            run=self.h.team.run_for_request(db,goal)
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(goal,)).fetchone()[0]
        raw='并行计划。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch','workers':[
                {'key':'A','objective':'独立核验甲，交付完整证据'},
                {'key':'B','objective':'独立核验乙，交付完整证据'}],
            'wait':{'mode':'all','workers':['A','B']},'resume':'逐份核对并整合'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=offer['attempt_id'],page=sent,
                                   assistant_turn_hash='d'*64,text=raw)['state'],'yielded')
        for _ in range(3):self.m.browser('list',{})
        pages={p['page_id']:p for p in self.m.browser('list',{})['pages']}
        children=sorted((p for p in pages.values() if p['parent_target']==main),key=lambda p:p['page_id'])
        self.assertEqual(len(children),2)
        self.assertEqual({p['collaboration_protocol'] for p in children},{'text_v1'})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                       (offer['attempt_id'],)).fetchone()[0],'waiting_pages')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',(run['id'],)).fetchone()[0],0)
        # Reconstruct the managed adapter from the same durable Host ledger.
        # Polling after a process restart must reuse the reserved child pages,
        # original run and claim instead of creating a second batch.
        from harness_managed import ManagedPages
        self.h.managed=ManagedPages(self.h);self.m=self.h.managed
        self.m.browser('list',{})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_pages WHERE parent_target=?',(main,)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',(run['id'],)).fetchone()[0],0)
        for index,child in enumerate(children):
            page=child['page_id'];self.sessions[page]='wc_sess_'+uuid.uuid4().hex
            self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':child['bootstrap_model_selection']})
            self.m.browser('bootstrap',{'page_id':page,'state':'sending'})
            self.m.browser('bootstrap',{'page_id':page,'state':'sent'})
            ticket=re.search(r'clwm_[A-Za-z0-9_-]{43}',child['bootstrap_text'])[0]
            reply=self.private(page,'enroll',{'ticket':ticket,'project':'own-project','root':str(self.f.root)})
            task=self.private(page,'first-task',{})['request']
            result_text='完整成果 '+str(index)
            if index==0:
                result_text+='\n'+'完整推导。'*10000+'\n首次任务尾部反例及修正必须完整带回'
                result_path=self.f.root/'first-worker-full-result.md'
                result_path.write_text(result_text,encoding='utf-8-sig')
                result_payload={'markdown_path':result_path.name}
            else:result_payload={'markdown':result_text}
            self.private(page,'turn-end',{'request_id':task['id'],'claim_id':task['claim_id'],'outcome':'completed',**result_payload})
            public_reply='完整成果 '+str(index)+'\n'+reply['browser_marker']
            self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),
                                   'public_text':public_reply,'preparation_markdown':public_reply,'source_hash':hashlib.sha256(public_reply.encode()).hexdigest()})
            self.m.browser('list',{})
            with closing(self.h.state.connect()) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',(run['id'],)).fetchone()[0],
                                 index+1)
                row=db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(goal,)).fetchone()
                self.assertEqual((row['phase'],row['claim_id']),('suspended',claim))
            if index==0:self.assertNotEqual(self.wire(main,'pulse',page=sent)['state'],'offer')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                       (offer['attempt_id'],)).fetchone()[0],'assigned')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_pages WHERE parent_target=?',(main,)).fetchone()[0],2)
        for child in children:
            self.assertNotEqual(self.wire(child['page_id'],'pulse',page=state)['state'],'offer')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT dispatches FROM host_runs WHERE id=?',(run['id'],)).fetchone()[0],3)
        next_offer=self.wire(main,'pulse',page=sent)
        self.assertEqual(next_offer['state'],'offer')
        prompt=self.wire(main,'dispatch',attempt_id=next_offer['attempt_id'],page=sent)['prompt']
        self.assertIn('完整成果 0',prompt);self.assertIn('完整成果 1',prompt)
        self.assertIn('首次任务尾部反例及修正必须完整带回',prompt)
        self.wire(main,'sent',attempt_id=next_offer['attempt_id'],page={**state,'generating':True},assistant_before_hash='d'*64)
        final='整合完成。\n```clw-plan-v1\n{"version":1,"action":"completed","summary":"两份证据已核对"}\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':next_offer['attempt_id'],'text':final,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=next_offer['attempt_id'],page=state,
                                   assistant_turn_hash='e'*64,text=final)['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',(run['id'],)).fetchone()[0],'closed')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads WHERE run_id=?',(run['id'],)).fetchone()[0],2)
    def test_text_plan_cannot_expand_controller_write_permission(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        request=self.f.command(b['thread_id'],'message.send',{'text':'只读研究'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        offer=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=offer['attempt_id'],page=page)
        self.wire(main,'sent',attempt_id=offer['attempt_id'],page={**page,'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        raw='计划\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch',
            'workers':[{'key':'A','objective':'写入未获准目录','access':'write','write_paths':['src']}],
            'wait':{'mode':'all','workers':['A']},'resume':'整合'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
        result=self.wire(main,'result',attempt_id=offer['attempt_id'],
                         page={**page,'user_hash':'b'*64},assistant_turn_hash='d'*64,text=raw)
        self.assertEqual(result['state'],'needs_attention')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_pages WHERE parent_target=?',(main,)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_text_batches').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
    def test_text_plan_requires_artifact_from_confirmed_browser_turn(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        request=self.f.command(b['thread_id'],'message.send',{'text':'核验来源'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        offer=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=offer['attempt_id'],page=page)
        sent={**page,'user_hash':'b'*64}
        self.wire(main,'sent',attempt_id=offer['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        raw='完成。\n```clw-plan-v1\n{"version":1,"action":"completed","summary":"已核验"}\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':offer['attempt_id'],
                                   'text':raw,'assistant_turn_hash':'d'*64})
        mismatch=self.wire(main,'result',attempt_id=offer['attempt_id'],page=sent,
                           assistant_turn_hash='e'*64,text=raw)
        self.assertEqual(mismatch['state'],'needs_attention')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_text_plans').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'processing')
    def test_text_late_worker_attention_keeps_new_dispatch_and_wakes_once(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        old,_=self.enroll(main);new,_=self.enroll(main)
        request=self.f.command(b['thread_id'],'message.send',{'text':'检查两支结果'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        offer=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=offer['attempt_id'],page=page)
        sent={**page,'user_hash':'b'*64}
        self.wire(main,'sent',attempt_id=offer['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=main)
            run=self.h.team.run_for_request(db,request)
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0]
            self.h.team.assign(db,actor,{'run_id':run['id'],'claim_id':claim,
                         'target':old,'text':'已在途的核验','depends_on':[],'resources':[]},'old-work')
            db.commit()
        old_offer=self.wire(old,'pulse',page=page)
        self.wire(old,'dispatch',attempt_id=old_offer['attempt_id'],page=page)
        self.wire(old,'sent',attempt_id=old_offer['attempt_id'],
                  page={**sent,'generating':True},assistant_before_hash='c'*64)
        refusal='已完成独立引理，完整推导可供主控继续使用。\nThis tool call was blocked by OpenAI because we could not determine the safety status of the request.'
        cc=self.private(old,'context',{})
        self.private(old,'turn-end',{'request_id':old_offer['request_id'],
            'claim_id':cc['request']['claim_id'],'outcome':'needs_attention','markdown':refusal})
        self.m.browser('artifact',{'page_id':old,'attempt_id':old_offer['attempt_id'],
                                   'text':refusal,'assistant_turn_hash':'d'*64})
        # The worker explicitly declared an unresolved outcome through its
        # own authenticated tool. A phrase in a reply is not that decision.
        self.assertEqual(self.wire(old,'result',attempt_id=old_offer['attempt_id'],page=sent,
                                   assistant_turn_hash='d'*64,text=refusal)['state'],'needs_attention')
        plan='另一支继续。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch','workers':[{'key':'B','target':new,'objective':'独立核验乙'}],
            'wait':{'mode':'all','workers':['B']},'resume':'核对两支原记录'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':offer['attempt_id'],
                                   'text':plan,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=offer['attempt_id'],page=sent,
                                   assistant_turn_hash='e'*64,text=plan)['state'],'yielded')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',
                                        (run['id'],)).fetchone()[0],2)
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],'assigned')
        resumed=self.wire(main,'pulse',page=sent)
        self.assertEqual(resumed['state'],'offer')
        prompt=self.wire(main,'dispatch',attempt_id=resumed['attempt_id'],page=sent)['prompt']
        self.assertIn('协作者受阻时保存的原文',prompt)
        self.assertIn('已完成独立引理，完整推导可供主控继续使用。',prompt)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=main)
            current=self.h.team.run_for_request(db,request)
            attempt=db.execute('SELECT * FROM control_attempts WHERE id=?',(resumed['attempt_id'],)).fetchone()
            self.m.text._ack_delivered(db,actor,current,attempt)
            seen=db.execute('SELECT attempt_id FROM host_team_attention_reads WHERE run_id=?',(run['id'],)).fetchone()
            self.assertEqual(seen[0],old_offer['attempt_id'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',(run['id'],)).fetchone()[0],2)
        self.assertNotEqual(self.wire(main,'pulse',page=sent)['state'],'offer')
    def test_text_late_prior_result_waits_for_new_page_batch(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        prior,_=self.enroll(main)
        request=self.f.command(b['thread_id'],'message.send',{'text':'两批证据合并'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        first=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=first['attempt_id'],page=page)
        sent={**page,'user_hash':'b'*64}
        self.wire(main,'sent',attempt_id=first['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        with closing(self.h.state.connect()) as db:
            actor=self.h.binding(db,target=main);run=self.h.team.run_for_request(db,request)
            claim=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request,)).fetchone()[0]
            self.h.team.assign(db,actor,{'run_id':run['id'],'claim_id':claim,'target':prior,
                                         'text':'先前工作','depends_on':[],'resources':[]},'prior-work')
            db.commit()
        old=self.wire(prior,'pulse',page=page)
        self.wire(prior,'dispatch',attempt_id=old['attempt_id'],page=page)
        self.wire(prior,'sent',attempt_id=old['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        recovered='先前成果。某调用曾报告因 OpenAI 无法确定请求的安全状态；已修正参数并完成核验。'
        self.m.browser('artifact',{'page_id':prior,'attempt_id':old['attempt_id'],
                                   'text':recovered,'assistant_turn_hash':'d'*64})
        self.assertEqual(self.wire(prior,'result',attempt_id=old['attempt_id'],page=sent,
                                   assistant_turn_hash='d'*64,text=recovered)['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertFalse(db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',(old['request_id'],)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_worker_reported_tool_rejection' AND json_extract(data,'$.attempt_id')=?",(old['attempt_id'],)).fetchone()[0],1)
        plan='继续另一批。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch','workers':[{'key':'new','objective':'独立新证据'}],
            'wait':{'mode':'all','workers':['new']},'resume':'一并核对新旧成果'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':first['attempt_id'],
                                   'text':plan,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=first['attempt_id'],page=sent,
                                   assistant_turn_hash='e'*64,text=plan)['state'],'yielded')
        self.assertNotEqual(self.wire(main,'pulse',page=sent)['state'],'offer')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                        (first['attempt_id'],)).fetchone()[0],'waiting_pages')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',
                                        (run['id'],)).fetchone()[0],1)
    def test_text_plan_page_issue_wakes_original_controller_without_assigning(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        request=self.f.command(b['thread_id'],'message.send',{'text':'安排研究'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        offer=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=offer['attempt_id'],page=page)
        self.wire(main,'sent',attempt_id=offer['attempt_id'],page={**page,'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        raw='计划\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch',
            'workers':[{'key':'A','objective':'核验甲'},{'key':'B','objective':'核验乙'}],
            'wait':{'mode':'all','workers':['A','B']},'resume':'整合'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':offer['attempt_id'],'text':raw,'assistant_turn_hash':'d'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=offer['attempt_id'],
                                   page={**page,'user_hash':'b'*64},assistant_turn_hash='d'*64,text=raw)['state'],'yielded')
        child=next(p for p in self.m.browser('list',{})['pages'] if p['parent_target']==main)
        self.m.browser('page-issue',{'page_id':child['page_id'],'kind':'bootstrap_failed','detail':'明确接入失败'})
        self.m.browser('list',{})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                       (offer['attempt_id'],)).fetchone()[0],'needs_attention')
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'suspended')
        next_offer=self.wire(main,'pulse',page={**page,'user_hash':'b'*64})
        self.assertEqual(next_offer['state'],'offer')
        self.assertIn('尚未完成的原协作批次',self.wire(main,'dispatch',
                     page={**page,'user_hash':'b'*64},attempt_id=next_offer['attempt_id'])['prompt'])
        self.wire(main,'sent',attempt_id=next_offer['attempt_id'],
                  page={**page,'user_hash':'a'*64,'generating':True},assistant_before_hash='d'*64)
        final='接入失败，安全收尾。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'completed','summary':'原批未派发，保留接入失败记录',
            'resolve_batch':{'attempt_id':offer['attempt_id'],'decision':'abandon'}},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':next_offer['attempt_id'],
                                   'text':final,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=next_offer['attempt_id'],
                                   page={**page,'user_hash':'a'*64},assistant_turn_hash='e'*64,
                                   text=final)['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                        (offer['attempt_id'],)).fetchone()[0],'abandoned')
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE controller_request=?',
                                        (request,)).fetchone()[0],'closed')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work').fetchone()[0],0)
    def test_text_issue_retry_waits_for_original_pages_then_completes_once(self):
        model,effort='GPT-5.6 · 最新','极高'
        main,b=self.enroll(collaboration_protocol='text_v1',model=model,effort=effort)
        request=self.f.command(b['thread_id'],'message.send',{'text':'并行核验后整合'})['request_id']
        page={**PAGE,'model_label':model,'effort_label':effort}
        first=self.wire(main,'pulse',page=page)
        self.wire(main,'dispatch',attempt_id=first['attempt_id'],page=page)
        sent={**page,'user_hash':'b'*64}
        self.wire(main,'sent',attempt_id=first['attempt_id'],page={**sent,'generating':True},assistant_before_hash='c'*64)
        plan='计划\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'dispatch','workers':[{'key':'A','objective':'核验甲'},
                                                     {'key':'B','objective':'核验乙'}],
            'wait':{'mode':'all','workers':['A','B']},'resume':'核对原文并整合'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':first['attempt_id'],
                                   'text':plan,'assistant_turn_hash':'d'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=first['attempt_id'],page=sent,
                                   assistant_turn_hash='d'*64,text=plan)['state'],'yielded')
        children=[p for p in self.m.browser('list',{})['pages'] if p['parent_target']==main]
        self.assertEqual(len(children),2)
        self.m.browser('page-issue',{'page_id':children[0]['page_id'],
                                    'kind':'bootstrap_failed','detail':'明确接入失败'})
        self.m.browser('list',{})
        second=self.wire(main,'pulse',page=sent)
        self.wire(main,'dispatch',attempt_id=second['attempt_id'],page=sent)
        self.wire(main,'sent',attempt_id=second['attempt_id'],
                  page={**page,'user_hash':'a'*64,'generating':True},assistant_before_hash='d'*64)
        retry='保留原页面等待明确修复。\n```clw-plan-v1\n'+json.dumps({
            'version':1,'action':'retry_batch','attempt_id':first['attempt_id'],
            'reason':'只核对原接入回执，不重放已接受调用'},ensure_ascii=False)+'\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':second['attempt_id'],
                                   'text':retry,'assistant_turn_hash':'e'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=second['attempt_id'],
                                   page={**page,'user_hash':'a'*64},assistant_turn_hash='e'*64,
                                   text=retry)['state'],'yielded')
        self.assertNotEqual(self.wire(main,'pulse',page={**page,'user_hash':'a'*64})['state'],'offer')
        for i,child in enumerate(children):
            cid=child['page_id']
            if cid==children[0]['page_id']:
                self.m.browser('pause',{'page_id':cid,'paused':False})
            self.m.browser('bootstrap-model-ready',{'page_id':cid,'model_selection':child['bootstrap_model_selection']})
            self.m.browser('bootstrap',{'page_id':cid,'state':'sending'})
            self.m.browser('bootstrap',{'page_id':cid,'state':'sent'})
            self.sessions[cid]='wc_sess_'+uuid.uuid4().hex
            ticket=re.search(r'clwm_[A-Za-z0-9_-]{43}',child['bootstrap_text'])[0]
            enrolled=self.private(cid,'enroll',{'ticket':ticket,'project':'own-project','root':str(self.f.root)})
            task=self.private(cid,'first-task',{})['request']
            body='可核验成果 '+str(i)
            self.private(cid,'turn-end',{'request_id':task['id'],'claim_id':task['claim_id'],'outcome':'completed','markdown':body})
            public=body+'\n'+enrolled['browser_marker']
            self.m.browser('bind',{'page_id':cid,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),
                                   'public_text':public,'preparation_markdown':public,'source_hash':hashlib.sha256(public.encode()).hexdigest()})
            self.m.browser('list',{})
        with closing(self.h.state.connect()) as db:
            run=self.h.team.run_for_request(db,request)
            self.assertEqual(db.execute('SELECT state FROM managed_text_batches WHERE attempt_id=?',
                                        (first['attempt_id'],)).fetchone()[0],'assigned')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',
                                        (run['id'],)).fetchone()[0],2)
        for child in children:
            self.assertNotEqual(self.wire(child['page_id'],'pulse',page=page)['state'],'offer')
        final_offer=self.wire(main,'pulse',page={**page,'user_hash':'a'*64})
        self.assertEqual(final_offer['state'],'offer')
        final_prompt=self.wire(main,'dispatch',attempt_id=final_offer['attempt_id'],
                               page={**page,'user_hash':'a'*64})['prompt']
        self.assertIn('可核验成果 0',final_prompt)
        self.assertIn('可核验成果 1',final_prompt)
        self.wire(main,'sent',attempt_id=final_offer['attempt_id'],
                  page={**sent,'generating':True},assistant_before_hash='e'*64)
        done='整合完成\n```clw-plan-v1\n{"version":1,"action":"completed","summary":"已整合"}\n```'
        self.m.browser('artifact',{'page_id':main,'attempt_id':final_offer['attempt_id'],
                                   'text':done,'assistant_turn_hash':'f'*64})
        self.assertEqual(self.wire(main,'result',attempt_id=final_offer['attempt_id'],
                                   page=sent,assistant_turn_hash='f'*64,text=done)['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE controller_request=?',
                                        (request,)).fetchone()[0],'closed')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads WHERE run_id=?',
                                        (run['id'],)).fetchone()[0],2)
    def test_own_session_receipt_can_arrive_before_browser_ack_without_losing_the_turn(self):
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'fast MCP turn'})['request_id']
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        early=self.private(page,'context',{'attempt_id':offer['attempt_id']})
        self.assertEqual(early['request']['phase'],'processing');self.assertEqual(early['run']['dispatches'],1)
        claim=early['request']['claim_id']
        self.private(page,'turn-end',{'request_id':request,'claim_id':claim,'outcome':'completed','markdown':'Complete tool result before DOM acknowledgement.'})
        self.assertEqual(self.wire(page,'pulse')['state'],'model_received_browser_confirmation_pending')
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        with self.assertRaises(HarnessError):self.wire(page,'result',page=sent,attempt_id=offer['attempt_id'],assistant_turn_hash='e'*64,text='early DOM')
        self.wire(page,'sent',page=sent,attempt_id=offer['attempt_id'],assistant_before_hash='c'*64)
        again=self.private(page,'context',{'attempt_id':offer['attempt_id']})
        self.assertEqual(again['request']['claim_id'],claim);self.assertEqual(again['run']['dispatches'],1)
        result=self.wire(page,'result',page=sent,attempt_id=offer['attempt_id'],assistant_turn_hash='e'*64,text='public result')
        self.assertEqual(result['state'],'completed')
        with self.assertRaises(HarnessError):self.private(page,'context',{'attempt_id':offer['attempt_id']})
    def test_delayed_browser_ack_cannot_resume_a_turn_that_already_yielded_through_tools(self):
        page,b=self.enroll();self.f.command(b['thread_id'],'message.send',{'text':'wait for a child'})
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with self.assertRaises(HarnessError):self.private(page,'context',{'attempt_id':offer['attempt_id']})
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        context=self.private(page,'context',{'attempt_id':offer['attempt_id']});child,_=self.reserve(page)
        foreign,_=self.enroll()
        with self.assertRaises(HarnessError):self.private(foreign,'context',{'attempt_id':offer['attempt_id']})
        self.assertEqual(self.private(page,'wait-ready',{'targets':[child]})['state'],'waiting_events')
        self.assertEqual(self.private(page,'context',{'attempt_id':offer['attempt_id']})['request']['phase'],'suspended')
        sent={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        self.wire(page,'sent',page=sent,attempt_id=offer['attempt_id'],assistant_before_hash='c'*64)
        after=self.private(page,'context',{})
        self.assertEqual(after['request']['phase'],'suspended');self.assertEqual(after['request']['claim_id'],context['request']['claim_id'])
    def test_turn_requires_explicit_outcome_and_preserves_tool_markdown(self):
        page,request,offer,context=self.start_browser_turn()
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        args={'attempt_id':offer['attempt_id'],'page':result_page,'assistant_turn_hash':'d'*64,'text':'DOM supplemental preview'}
        raw='精确源文\n\\[x_1^2 + \\alpha\\]\n```python\nprint("a_b")\n```'
        delivery=context['result_delivery'];argv=delivery['argv']
        saved=self.private(page,'turn-end',{**delivery['payload'],'markdown':raw},argv[argv.index('--operation-id')+1])
        self.assertEqual(saved['state'],'turn_outcome_saved')
        result=self.wire(page,'result',**args);self.assertEqual(result['state'],'completed')
        replay=self.wire(page,'result',**args);self.assertTrue(replay['replayed'])
        with closing(self.h.state.connect()) as db:
            event=db.execute("SELECT data FROM events WHERE kind='assistant_message' AND thread_id=? ORDER BY seq DESC LIMIT 1",(context['request']['thread_id'],)).fetchone()
            self.assertEqual(json.loads(event[0])['text'],raw)
    def test_missing_tool_outcome_parks_original_instead_of_false_completion(self):
        page,request,offer,context=self.start_browser_turn()
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        result=self.wire(page,'result',attempt_id=offer['attempt_id'],page=result_page,assistant_turn_hash='d'*64,text='原 Job 仍在等待，没有宣布完成。')
        self.assertEqual(result['state'],'needs_attention')
        current=self.private(page,'context',{})
        self.assertEqual((current['request']['phase'],current['request']['claim_id']),('processing',context['request']['claim_id']))
        self.assertTrue(self.m.browser('list',{})['pages'][0]['paused'])
    def test_reloaded_browser_identity_requires_same_page_marker_and_original_tool_outcome(self):
        page,request,offer,context=self.start_browser_turn()
        row=self.m.browser('list',{})['pages'][0]
        args={'page_id':page,'url':row['url'],'attempt_id':offer['attempt_id'],'previous_user_hash':'b'*64,'user_hash':'f'*64,'marker':f'[CLW:{offer["attempt_id"]}]','marker_count':1}
        self.private(page,'turn-end',{'request_id':request,'claim_id':context['request']['claim_id'],'outcome':'completed','markdown':'Original complete result.'})
        for change in ({'url':'https://chatgpt.com/c/other'},{'marker':'[CLW:other]'},{'marker_count':2},{'previous_user_hash':'e'*64}):
            with self.subTest(change=change),self.assertRaises(HarnessError):self.m.browser('reconcile-user',{**args,**change})
        self.assertFalse(self.m.browser('reconcile-user',args)['request_replayed'])
        with closing(self.h.state.connect()) as db:
            event=json.loads(db.execute("SELECT data FROM events WHERE kind='managed_browser_identity_reconciled'").fetchone()[0])
            self.assertEqual(event['previous_user_hash'],'b'*64)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
        result=self.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':row['model'],'effort_label':row['effort'],'user_hash':'f'*64},assistant_turn_hash='d'*64,text='Original public answer')
        self.assertEqual(result['state'],'completed')
        with self.assertRaises(HarnessError):self.m.browser('reconcile-user',args)
    def test_missing_receipt_remounted_reply_is_attention_even_if_tool_receipt_arrives_late(self):
        page,request,offer,context=self.start_browser_turn()
        row=self.m.browser('list',{})['pages'][0]
        args={'page_id':page,'url':row['url'],'attempt_id':offer['attempt_id'],'previous_user_hash':'b'*64,'user_hash':'f'*64,'marker':f'[CLW:{offer["attempt_id"]}]','marker_count':1}
        for change in ({'url':'https://chatgpt.com/c/other'},{'marker':'[CLW:other]'},{'marker_count':2},{'previous_user_hash':'e'*64}):
            with self.subTest(change=change),self.assertRaises(HarnessError):self.m.browser('reconcile-user',{**args,**change})
        self.assertTrue(self.m.browser('reconcile-user',args)['attention_only'])
        self.private(page,'turn-end',{'request_id':request,'claim_id':context['request']['claim_id'],'outcome':'completed','markdown':'Late tool result'})
        self.m.browser('artifact',{'page_id':page,'attempt_id':offer['attempt_id'],'text':'Public refusal and partial manuscript'})
        result=self.wire(page,'result',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':row['model'],'effort_label':row['effort'],'user_hash':'f'*64},assistant_turn_hash='d'*64,text='Public refusal and partial manuscript')
        self.assertEqual(result['state'],'needs_attention')
        current=self.private(page,'context',{})
        self.assertEqual(current['request']['claim_id'],context['request']['claim_id'])
        self.assertTrue(self.m.browser('list',{})['pages'][0]['paused'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE request_id=?',(request,)).fetchone()[0],2)
    def test_text_worker_reconciles_completed_public_identity_without_tool_outcome(self):
        _,worker,_,request,_,observation=self.start_partial_text_worker()
        attempt=observation['attempt_id']
        self.wire(worker,'sent',attempt_id=attempt,
                  page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                        'user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        payload={'page_id':worker,'url':observation['url'],'attempt_id':attempt,
                 'previous_user_hash':'b'*64,'user_hash':'f'*64,
                 'marker':f'[CLW:{attempt}]','marker_count':1,
                 'complete':True,'history_at_latest':True,'assistant_turn_hash':'d'*64}
        with self.assertRaises(HarnessError):
            self.m.browser('reconcile-user',{**payload,'complete':False})
        result=self.m.browser('reconcile-user',payload)
        self.assertFalse(result['attention_only'])
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_unverified_identities WHERE attempt_id=?',(attempt,)).fetchone()[0],0)
        self.m.browser('artifact',{'page_id':worker,'attempt_id':attempt,
                                   'text':'B fixture complete original evidence',
                                   'assistant_turn_hash':'d'*64})
        done=self.wire(worker,'result',attempt_id=attempt,
                       page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高',
                             'user_hash':'f'*64},assistant_turn_hash='d'*64,
                       text='B fixture complete original evidence')
        self.assertEqual(done['state'],'completed')
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?',(request,)).fetchone()[0],'completed')
    def test_page_readiness_yields_once_and_early_results_wait_for_original_turn_end(self):
        page,request,offer,context=self.start_browser_turn();child,created=self.reserve(page)
        wait=self.private(page,'wait-ready',{'targets':[child]})
        self.assertEqual(wait['state'],'waiting_events')
        self.sessions[child]='wc_sess_'+uuid.uuid4().hex
        ticket=re.search(r'clwm_[A-Za-z0-9_-]{43}',created['bootstrap_text'])[0]
        receiver=self.private(child,'enroll',{'ticket':ticket,'project':'own-project','root':str(self.f.root)})
        self.m.browser('bind',{'page_id':child,'url':'https://chatgpt.com/c/'+str(uuid.uuid4()),'public_text':receiver['browser_marker']})
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        self.assertEqual(self.wire(page,'pulse',page=result_page)['state'],'browser_result_pending')
        self.assertEqual(self.wire(page,'result',attempt_id=offer['attempt_id'],page=result_page,assistant_turn_hash='d'*64,text='等待接入')['state'],'yielded')
        next_offer=self.wire(page,'pulse',page=result_page);self.assertEqual(next_offer['state'],'offer')
        self.m.browser('list',{});self.m.browser('list',{})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_pages_settled'").fetchone()[0],1)
        self.assertEqual(self.private(page,'context',{})['waiting_pages']['state'],'pages_ready')
    def test_page_permission_problem_wakes_waiting_master_without_retrying_worker(self):
        page,request,offer,context=self.start_browser_turn();child,_=self.reserve(page)
        self.private(page,'wait-ready',{'targets':[child]})
        self.m.browser('page-issue',{'page_id':child,'kind':'bootstrap_receipt_missing','detail':'平台拒绝工具调用，未重试。'})
        info=self.private(page,'context',{})['waiting_pages']
        self.assertEqual(info['state'],'pages_need_attention');self.assertTrue(info['pages'][0]['paused'])
        with self.assertRaises(HarnessError):self.m.browser('bootstrap',{'page_id':child,'state':'sending'})
    def test_attention_is_not_task_completion_or_new_claim(self):
        page,request,offer,context=self.start_browser_turn();claim=context['request']['claim_id']
        self.private(page,'turn-end',{'request_id':request,'claim_id':claim,'outcome':'needs_attention','markdown':'授权需要本人处理。'})
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        result=self.wire(page,'result',attempt_id=offer['attempt_id'],page=result_page,assistant_turn_hash='d'*64,text='需要处理')
        self.assertEqual(result['state'],'needs_attention')
        current=self.private(page,'context',{})['request'];self.assertEqual((current['phase'],current['claim_id']),('processing',claim))
        self.assertTrue(self.m.browser('list',{})['pages'][0]['paused'])
        resumed=self.m.browser('pause',{'page_id':page,'paused':False})
        self.assertEqual(resumed['resumed_original_requests'],[request])
        self.assertEqual(self.m.browser('pause',{'page_id':page,'paused':False})['resumed_original_requests'],[])
        next_offer=self.wire(page,'pulse',page=result_page)
        self.assertEqual(next_offer['state'],'offer');self.assertNotEqual(next_offer['attempt_id'],offer['attempt_id'])
        self.wire(page,'dispatch',attempt_id=next_offer['attempt_id'],page=result_page)
        self.wire(page,'sent',attempt_id=next_offer['attempt_id'],page={**result_page,'user_hash':'e'*64,'generating':True},assistant_before_hash='d'*64)
        recovered=self.private(page,'context',{})
        self.assertEqual(recovered['request']['claim_id'],claim);self.assertEqual(recovered['request']['id'],request)
        self.assertEqual(recovered['run']['dispatches'],2)
    def test_prepared_send_baseline_survives_service_reconstruction(self):
        page,request,offer,context=self.start_browser_turn()
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':'c'*64,'prompt_hash':'d'*64})
        from harness_managed import ManagedPages
        restored=ManagedPages(self.h)
        self.assertEqual(restored.browser('prepared',{'page_id':page,'attempt_id':offer['attempt_id']})['assistant_before_hash'],'c'*64)
    def test_observed_stop_keeps_original_claim_and_only_explicit_resume_wakes_it(self):
        page,request,offer,context=self.start_browser_turn();claim=context['request']['claim_id']
        row=self.m.browser('list',{})['pages'][0]
        payload={'page_id':page,'url':row['url'],'user_hash':'b'*64,'turn_hash':'d'*64,'generating':False,'observed_stopped':True,'stop_clicked':False}
        with self.assertRaises(HarnessError):self.m.browser('stop-observed',{**payload,'user_hash':'e'*64})
        with self.assertRaises(HarnessError):self.m.browser('stop-observed',{**payload,'generating':True})
        reply=self.m.browser('stop-observed',payload)
        self.assertFalse(reply['local_execution_stopped'])
        self.assertEqual(self.m.browser('stop-observed',payload)['state'],'stop_already_observed')
        self.assertTrue(self.m.browser('list',{})['pages'][0]['paused'])
        self.assertEqual(self.private(page,'context',{})['request']['claim_id'],claim)
        from harness_managed import ManagedPages
        self.assertTrue(ManagedPages(self.h).browser('list',{})['pages'][0]['paused'])
        self.m.browser('pause',{'page_id':page,'paused':False})
        stopped={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'stopped':True}
        next_offer=self.wire(page,'pulse',page=stopped)
        self.assertEqual(next_offer['state'],'offer')
        self.wire(page,'dispatch',attempt_id=next_offer['attempt_id'],page=stopped)
        self.wire(page,'sent',attempt_id=next_offer['attempt_id'],page={**stopped,'user_hash':'e'*64,'stopped':False},assistant_before_hash='d'*64)
        resumed=self.private(page,'context',{})
        self.assertEqual((resumed['request']['id'],resumed['request']['claim_id']),(request,claim))
        self.assertEqual(resumed['run']['dispatches'],2)
    def test_late_notes_allow_current_delivery_then_form_one_new_request(self):
        page,request,offer,context=self.start_browser_turn();claim=context['request']['claim_id'];thread=context['request']['thread_id']
        self.private(page,'turn-end',{'request_id':request,'claim_id':claim,'outcome':'completed','markdown':'First result, kept as original artifact.'})
        for message in ('补充：保留公式','补充：保留代码'):
            saved=self.f.command(thread,'message.append',{'text':message,'expected_request_id':request})
            self.assertEqual(saved['state'],'note_saved_not_native_interrupt')
        # UI polling never consumes either instruction.
        self.m.browser('view',{'page_id':page})
        result_page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64}
        result=self.wire(page,'result',attempt_id=offer['attempt_id'],page=result_page,assistant_turn_hash='d'*64,text='first public result')
        self.assertEqual(result['state'],'completed')
        batch=self.m.browser('next-round-prepare',{'page_id':page})['batch']
        self.f.command(thread,'message.send',{'text':batch['text']},key=batch['id'])
        next_offer=self.wire(page,'pulse',page=result_page)
        self.assertEqual(next_offer['state'],'offer')
        repeated=self.wire(page,'pulse',page=result_page)
        self.assertEqual(next_offer['attempt_id'],repeated['attempt_id'])
        grant=self.wire(page,'dispatch',page=result_page,attempt_id=next_offer['attempt_id'])
        self.assertIn('保留公式',grant['prompt']);self.assertIn('保留代码',grant['prompt'])
        self.wire(page,'sent',page={**result_page,'user_hash':'e'*64},attempt_id=next_offer['attempt_id'],assistant_before_hash='d'*64)
        resumed=self.private(page,'context',{})
        self.assertEqual(resumed['request']['id'],batch['id'])
        self.assertNotEqual(resumed['request']['claim_id'],claim)
        self.assertEqual(resumed['request']['text'],'补充：保留公式\n\n补充：保留代码')
        self.assertEqual(len(resumed['additional_instructions']),0)
        self.assertEqual(resumed['run']['dispatches'],1)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_artifacts WHERE request_id=?',(request,)).fetchone()[0],1)
            self.assertEqual(tuple(db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',(request,)).fetchone()),('completed',claim))
    def test_final_seal_ignores_next_round_notes_and_retains_future_append(self):
        page,request,offer,context=self.start_browser_turn();thread=context['request']['thread_id']
        self.f.command(thread,'message.append',{'text':'最后请说明边界','expected_request_id':request})
        payload={'run_id':context['run']['id'],'claim_id':context['request']['claim_id'],'summary':'完整结果','references':[]}
        def close_run():
            with closing(self.h.state.connect()) as db:
                value=self.h.team.lifecycle(db,self.h.binding(db,target=page),'close',payload);db.commit();return value
        self.assertEqual(close_run()['state'],'closed')
        context=self.private(page,'context',{})
        self.assertEqual(context['additional_instructions'],[])
        accepted=self.f.command(thread,'message.append',{'text':'新的范围','expected_request_id':request})
        self.assertEqual(accepted['delivery_scope'],'next_round')
        self.assertEqual(self.m.browser('view',{'page_id':page})['next_round']['count'],2)
    def test_view_distinguishes_delivery_without_consuming_notes(self):
        page,b=self.enroll();thread=b['thread_id']
        request=self.f.command(thread,'message.send',{'text':'queued goal'})['request_id']
        view=self.m.browser('view',{'page_id':page})
        self.assertEqual(next(e for e in view['events'] if e['kind']=='user_message')['delivery'],'queued')
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.assertEqual(next(e for e in self.m.browser('view',{'page_id':page})['events'] if e['kind']=='user_message')['delivery'],'confirming')
        self.wire(page,'sent',attempt_id=offer['attempt_id'],page={**PAGE,'model_label':'GPT-6 Astra Pro','effort_label':'最高','user_hash':'b'*64,'generating':True},assistant_before_hash='c'*64)
        self.f.command(thread,'message.append',{'text':'later instructions','expected_request_id':request})
        for _ in range(2):
            view=self.m.browser('view',{'page_id':page})
            self.assertEqual(view['pending_notes'],1)
            self.assertEqual(next(e for e in view['events'] if e['kind']=='user_message')['delivery'],'delivered')
            self.assertEqual(next(e for e in view['events'] if e['kind']=='host_user_note')['delivery'],'queued_note')
        self.private(page,'context',{})
        self.assertEqual(next(e for e in self.m.browser('view',{'page_id':page})['events'] if e['kind']=='host_user_note')['delivery'],'queued_note')
    def test_withdraw_unsent_offer_archives_goal_and_notes_and_restores_once(self):
        page,b=self.enroll();thread=b['thread_id']
        request=self.f.command(thread,'message.send',{'text':'mistaken goal'})['request_id']
        self.f.command(thread,'message.append',{'text':'unsent note','expected_request_id':request})
        offer=self.wire(page,'pulse');self.m.browser('pause',{'page_id':page,'paused':True})
        change={'page_id':page,'request_id':request}
        result=self.m.browser('withdraw',change)
        self.assertEqual(result['text'],'mistaken goal\n\nunsent note');self.assertFalse(result['replayed'])
        again=self.m.browser('withdraw',change);self.assertTrue(again['replayed']);self.assertEqual(again['text'],result['text'])
        view=self.m.browser('view',{'page_id':page});self.assertIsNone(view['request'])
        self.assertTrue(view['latest_request']['withdrawn']);self.assertEqual(view['latest_request']['phase'],'cancelled')
        self.assertFalse(any(e['kind']=='host_queued' for e in view['events']))
        self.assertEqual([e['delivery'] for e in view['events'] if e['kind'] in ('user_message','host_user_note')],['withdrawn','withdrawn'])
        self.assertTrue(self.m.browser('list',{})['pages'][0]['paused'])
        self.m.browser('pause',{'page_id':page,'paused':False})
        with self.assertRaises(HarnessError):self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        fresh=self.f.command(thread,'message.send',{'text':'correct goal'})
        self.assertEqual(fresh['state'],'queued_for_web_host')
    def test_withdraw_rejects_send_commit_and_foreign_request(self):
        page,b=self.enroll();foreign,_=self.enroll()
        request=self.f.command(b['thread_id'],'message.send',{'text':'goal'})['request_id']
        with self.assertRaises(HarnessError):self.m.browser('withdraw',{'page_id':foreign,'request_id':request})
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with self.assertRaisesRegex(HarnessError,'managed_message_already_delivering'):self.m.browser('withdraw',{'page_id':page,'request_id':request})
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT cancel_requested FROM host_requests WHERE id=?',(request,)).fetchone()[0],0)
    def test_next_round_note_withdrawal_is_independent_of_current_context_reads(self):
        page,request,offer,context=self.start_browser_turn()
        thread=context['request']['thread_id']
        one=self.f.command(thread,'message.append',{'text':'withdraw this','expected_request_id':request})['operation_id']
        two=self.f.command(thread,'message.append',{'text':'keep this','expected_request_id':request})['operation_id']
        result=self.m.browser('withdraw',{'page_id':page,'request_id':request,'note_id':one})
        self.assertEqual(result['text'],'withdraw this')
        received=self.private(page,'context',{})
        self.assertEqual(received['additional_instructions'],[])
        self.assertEqual(received['request']['claim_id'],context['request']['claim_id'])
        self.assertEqual(self.m.browser('withdraw',{'page_id':page,'request_id':request,'note_id':two})['text'],'keep this')
    def test_next_round_note_is_not_part_of_current_prepared_browser_send(self):
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'goal'})['request_id']
        note=self.f.command(b['thread_id'],'message.append',{'text':'reserved note','expected_request_id':request})['operation_id']
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.assertEqual(self.m.browser('withdraw',{'page_id':page,'request_id':request,'note_id':note})['text'],'reserved note')
    def test_model_preflight_rejects_unknown_original_send_before_controls_are_changed(self):
        page,b=self.enroll();self.f.command(b['thread_id'],'message.send',{'text':'goal'})
        payload={'page_id':page,'expected_model':'GPT-6 Astra Pro','expected_effort':'最高'}
        self.assertTrue(self.m.browser('model-change-check',payload)['ready'])
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with self.assertRaisesRegex(HarnessError,'managed_original_send_unconfirmed'):self.m.browser('model-change-check',payload)
    def test_model_change_at_unsent_boundary_preserves_pause_request_and_existing_workers(self):
        page,b=self.enroll();child,_=self.enroll(page)
        request=self.f.command(b['thread_id'],'message.send',{'text':'unsent goal'})['request_id']
        offer=self.wire(page,'pulse')
        self.m.browser('page-issue',{'page_id':page,'kind':'model_mismatch','detail':'web settings changed'})
        payload={'page_id':page,'model':'GPT-6 Astra Pro','effort':'中','model_selection':{'model':'GPT-6 Astra Pro','effort':'中'},'expected_model':'GPT-6 Astra Pro','expected_effort':'最高'}
        result=self.m.browser('configure-model',payload);self.assertTrue(result['paused'])
        rows={x['page_id']:x for x in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[page]['effort'],'中');self.assertEqual(rows[child]['effort'],'最高');self.assertIsNone(rows[page]['attention'])
        view=self.m.browser('view',{'page_id':page});self.assertEqual(view['request']['id'],request)
        self.assertEqual(view['attempt']['id'],offer['attempt_id']);self.assertIsNone(view['attempt']['dispatched'])
        with self.assertRaises(HarnessError):self.m.browser('configure-model',payload)
        self.m.browser('pause',{'page_id':page,'paused':False})
        newer,_=self.reserve(page)
        self.assertEqual(next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==newer)['effort'],'中')
    def test_active_turn_model_change_is_rejected_and_user_stop_is_not_cleared(self):
        page,request,offer,context=self.start_browser_turn()
        payload={'page_id':page,'model':'GPT-6 Astra Pro','effort':'中','model_selection':{'model':'GPT-6 Astra Pro','effort':'中'},'expected_model':'GPT-6 Astra Pro','expected_effort':'最高'}
        with self.assertRaises(HarnessError):self.m.browser('configure-model',payload)
        self.assertEqual(self.private(page,'context',{})['request']['claim_id'],context['request']['claim_id'])
        other,b=self.enroll();self.m.browser('page-issue',{'page_id':other,'kind':'user_stopped','detail':'user stopped'})
        self.m.browser('configure-model',{**payload,'page_id':other})
        row=next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==other)
        self.assertTrue(row['paused']);self.assertEqual(row['attention'],'user stopped')
    def test_explicit_worker_effort_is_not_overwritten_and_observed_alias_is_saved(self):
        page,b=self.enroll()
        payload={'page_id':'web-'+str(uuid.uuid4()),'title':'independent effort','root':str(self.f.root),'effort':'Medium'}
        result=self.private(page,'create',payload,'independent-effort-create')
        self.assertEqual(result['effort'],'medium')
        self.assertEqual(self.private(page,'create',payload,'independent-effort-create'),result)
        worker=next(p for p in self.m.browser('list',{})['pages'] if p['page_id']==payload['page_id'])
        self.assertEqual(worker['effort'],'medium');self.assertEqual(worker['model'],'gpt-6 astra pro')
        self.assertNotIn('slider',worker['model_selection'])
        verified=self.m.browser('worker-model-ready',{'page_id':worker['page_id'],'model_selection':{'model':'GPT-6 Astra Pro','effort':'中','slider':{'value':1,'min':0,'max':4}}})
        self.assertEqual(verified['effort'],'中')
        with self.assertRaises(HarnessError):self.m.browser('worker-model-ready',{'page_id':worker['page_id'],'model_selection':{'model':'GPT-6 Astra Pro','effort':'低'}})
        listed=self.private(page,'pages',{})['pages']
        self.assertEqual(next(p for p in listed if p['page_id']==worker['page_id'])['effort'],'中')
        self.assertEqual(next(p for p in listed if p['page_id']==page)['effort'],'最高')
    def test_resume_targets_original_queued_request_and_does_not_create_send(self):
        page,b=self.enroll();request=self.f.command(b['thread_id'],'message.send',{'text':'original'})['request_id']
        attempt=self.wire(page,'pulse')['attempt_id']
        self.m.browser('page-issue',{'page_id':page,'kind':'user_stopped','detail':'stopped'})
        with self.assertRaises(HarnessError):self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':'stale'})
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        view=self.m.browser('view',{'page_id':page})
        self.assertEqual(view['request']['id'],request);self.assertEqual(view['attempt']['id'],attempt);self.assertIsNone(view['attempt']['dispatched'])
    def test_large_raw_result_is_saved_without_truncation(self):
        page,request,offer,context=self.start_browser_turn()
        raw=('\\[x_1 + \\alpha\\]\n'*20000);path=self.f.root/'long-result.md';path.write_text(raw,encoding='utf-8')
        receipt=self.private(page,'turn-end',{'request_id':request,'claim_id':context['request']['claim_id'],'outcome':'completed','markdown_path':'long-result.md'})
        self.assertEqual(Path(receipt['path']).read_text(encoding='utf-8'),raw)

if __name__=='__main__':unittest.main()
