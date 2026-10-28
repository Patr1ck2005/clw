"""Original enrolled Session and SQLite protocol; no production or model calls."""
from pathlib import Path
from contextlib import closing
import sys,json,unittest,hashlib
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed_first_task as fixture
from test_harness_control_plane import PAGE
from harness_state import HarnessError
from harness_managed_carrier_recovery import EMPTY,KEY

class CarrierRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.first=fixture.FirstTaskTests();self.first.setUp();self.f=self.first.f;self.m=self.first.m;self.h=self.f.h
    def tearDown(self):self.first.tearDown()
    def setup_original(self):
        page,enrollment=self.first.receive(account='A')
        self.m.browser('bind-first-turn',self.first.public_turn(page,'Original enrollment ended before business admission.'))
        row=self.row(page);request=row['latest_request']['id']
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        offered=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offered['attempt_id'])
        self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offered['attempt_id'],'result':'not_sent'}})
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        return page,request,offered['attempt_id']
    def row(self,page):return next(x for x in self.m.browser('list',{})['pages'] if x['page_id']==page)
    def wire(self,page_id,action,**extra):
        row=self.row(page_id)
        return self.f.wire(page_id,action,page={**PAGE,'model_label':row['model'],'effort_label':row['effort'],'user_hash':EMPTY,'user_known':False,**extra.pop('page',{})},**extra)
    def evidence(self):
        return {'url':'https://chatgpt.com/','at':int(self.h.clock()*1000),'document_generation':1,'editor':True,
            'control_known':True,'history_at_latest':True,'user_hash':EMPTY,'assistant_hash':EMPTY,'generating':False,
            'draft':False,'composing':False,'approval':False,'login':False,'blocked':False,'access_limited':False,'complete':False,'marker_count':0}
    def prepare(self,page):
        scope=self.m.browser('carrier-recovery-check',{'page_id':page});self.assertTrue(scope['eligible'],scope)
        return self.m.browser('recover-empty-carrier',{'page_id':page,'expected':scope,'browser':self.evidence()})
    def bind_payload(self,page,descriptor,attempt,url='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555'):
        return {'page_id':page,'recovery_id':descriptor['id'],'request_id':descriptor['request_id'],'attempt_id':attempt,
            'original_url':descriptor['original_url'],'account':'A','url':url,'browser':{'at':int(self.h.clock()*1000),
            'user_hash':'b'*64,'marker':'[CLW:'+attempt+']','marker_count':1,'history_at_latest':True,
            'draft':False,'composing':False,'login':False,'blocked':False,'access_limited':False}}
    def test_same_business_request_original_session_and_goal_survive_homepage_and_send(self):
        page,request,old=self.setup_original();before=self.row(page)
        goal=self.m.browser('goal-read',{'page_id':page})['goal']
        saved_goal=self.m.browser('goal-save',{'page_id':page,'operation_id':'carrier-goal-original-fixed-key',
            'expected_etag':goal['etag'],'expected_goal_request_id':goal['request_id'],
            'objective':'Original manual product acceptance goal.'})['goal']
        with closing(self.h.state.connect()) as db:
            old_attempt=dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(old,)).fetchone())
            old_binding=dict(db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(before['thread_id'],)).fetchone())
        descriptor=self.prepare(page);self.assertEqual(self.row(page)['url'],before['url'])
        offer=self.wire(page,'pulse');self.assertEqual(offer['request_id'],request)
        grant=self.wire(page,'dispatch',attempt_id=offer['attempt_id']);self.assertTrue(grant['dispatch'])
        self.assertIn('--session-id '+self.f.sessions[page],grant['prompt'])
        self.assertIn('沿本对话原 Session 执行',grant['prompt'])
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':EMPTY,'prompt_hash':hashlib.sha256(grant['prompt'].encode()).hexdigest()})
        payload=self.bind_payload(page,descriptor,offer['attempt_id']);bound=self.m.browser('bind-recovered-carrier',payload)
        self.assertEqual(bound['state'],'bound');self.assertEqual(self.m.browser('bind-recovered-carrier',payload),bound)
        sent=self.wire(page,'sent',attempt_id=offer['attempt_id'],assistant_before_hash=EMPTY,page={'user_hash':'b'*64,'user_known':True,'generating':True})
        self.assertEqual(sent['state'],'browser_result_pending');self.assertEqual(self.row(page)['latest_request']['id'],request)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(dict(db.execute('SELECT * FROM control_attempts WHERE id=?',(old,)).fetchone()),old_attempt)
            self.assertEqual(dict(db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(before['thread_id'],)).fetchone()),old_binding)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(before['thread_id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT bootstrap_state FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0],'sent')
        self.assertFalse(self.m.browser('carrier-recovery-check',{'page_id':page})['eligible'])
        after_goal=self.m.browser('goal-read',{'page_id':page})['goal']
        for key in ('revision','mode','state','objective','request_id'):self.assertEqual(after_goal[key],saved_goal[key])
    def test_original_send_or_history_never_becomes_new_empty_carrier_authority(self):
        for change in ("UPDATE control_attempts SET state='unknown'", "UPDATE control_attempts SET state='sent'", "UPDATE control_attempts SET state='dispatching'", "UPDATE control_attempts SET acknowledged=1", "UPDATE host_requests SET claim_id='original-claim'", "UPDATE host_requests SET phase='processing'", "UPDATE managed_pages SET bootstrap_state='unknown'", "UPDATE host_bindings SET enabled=0"):
            with self.subTest(change=change):
                page,_,_=self.setup_original()
                with closing(self.h.state.connect()) as db:db.execute(change);db.commit()
                self.assertFalse(self.m.browser('carrier-recovery-check',{'page_id':page})['eligible'])
    def test_empty_observation_requires_every_public_guard_and_fresh_original_scope(self):
        page,_,_=self.setup_original();scope=self.m.browser('carrier-recovery-check',{'page_id':page})
        for key,value in [('draft',True),('generating',True),('approval',True),('blocked',True),('login',True),('access_limited',True),('complete',True),('composing',True),('user_hash','b'*64),('assistant_hash','b'*64),('marker_count',1),('history_at_latest',False),('at',0),('document_generation',0)]:
            with self.subTest(key=key),self.assertRaises(HarnessError):
                self.m.browser('recover-empty-carrier',{'page_id':page,'expected':scope,'browser':{**self.evidence(),key:value}})
        with closing(self.h.state.connect()) as db:
            settings=json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?',(page,)).fetchone()[0]);settings['account']='B'
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),page));db.commit()
        with self.assertRaises(HarnessError):self.m.browser('recover-empty-carrier',{'page_id':page,'expected':scope,'browser':self.evidence()})
    def test_scope_and_original_session_changes_after_preparation_reject_dispatch(self):
        for changed in ('session','scope','account'):
            with self.subTest(changed=changed):
                page,_,_=self.setup_original();self.prepare(page);offer=self.wire(page,'pulse');row=self.row(page)
                with closing(self.h.state.connect()) as db:
                    if changed=='session':
                        spec=json.loads(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(row['thread_id'],)).fetchone()[0]);spec['session_id']='wc_sess_foreign'
                        db.execute('UPDATE host_bindings SET spec=? WHERE thread_id=?',(json.dumps(spec),row['thread_id']))
                    elif changed=='scope':db.execute("UPDATE host_team_scopes SET resources='[\"other\"]' WHERE thread_id=?",(row['thread_id'],))
                    else:
                        settings=json.loads(row['settings']);settings['account']='B';db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(json.dumps(settings),page))
                    db.commit()
                with self.assertRaisesRegex(HarnessError,'managed_empty_carrier_dispatch_changed'):self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
    def test_rebind_requires_exact_dispatched_prepared_original_marker_and_url(self):
        page,_,_=self.setup_original();descriptor=self.prepare(page);offer=self.wire(page,'pulse')
        payload=self.bind_payload(page,descriptor,offer['attempt_id'])
        with self.assertRaises(HarnessError):self.m.browser('bind-recovered-carrier',payload)
        self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        with self.assertRaises(HarnessError):self.m.browser('bind-recovered-carrier',payload)
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':EMPTY,'prompt_hash':'a'*64})
        for key,value in [('marker','foreign'),('marker_count',2),('draft',True),('login',True),('history_at_latest',False),('user_hash',EMPTY)]:
            with self.subTest(key=key),self.assertRaises(HarnessError):self.m.browser('bind-recovered-carrier',{**payload,'browser':{**payload['browser'],key:value}})
        self.m.browser('bind-recovered-carrier',payload)
        with self.assertRaises(HarnessError):self.m.browser('bind-recovered-carrier',{**payload,'url':'https://chatgpt.com/c/66666666-2222-3333-4444-555555555555'})
    def test_a_current_lease_result_other_business_request_or_missing_resume_prevents_recovery(self):
        for kind in ('lease','reply','history','tool','resume'):
            with self.subTest(kind=kind):
                page,request,attempt=self.setup_original();row=self.row(page)
                with closing(self.h.state.connect()) as db:
                    if kind=='lease':db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)',(request,'held-run',row['thread_id'],row['root'],'read','[]',self.h.clock()))
                    elif kind=='reply':db.execute('INSERT INTO host_replies VALUES(?,?,?,?)',('saved-reply',request,'original-fingerprint','{}'))
                    elif kind=='history':db.execute('INSERT INTO host_requests VALUES(?,?,?,?,?,?,?,?)',('older-business',row['thread_id'],'old task','completed',None,0,'old-date','old-date'))
                    elif kind=='tool':db.execute('INSERT INTO managed_tool_received VALUES(?,?)',(attempt,self.h.clock()))
                    else:db.execute("DELETE FROM events WHERE thread_id=? AND kind='managed_unsent_retry_authorized'",(row['thread_id'],))
                    db.commit()
                self.assertFalse(self.m.browser('carrier-recovery-check',{'page_id':page})['eligible'])
    def test_first_recovery_not_sent_needs_new_explicit_epoch_and_preserves_descriptor_history(self):
        page,request,old=self.setup_original();descriptor=self.prepare(page);offer=self.wire(page,'pulse')
        self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('wire',{'page_id':page,'data':{'action':'finish','attempt_id':offer['attempt_id'],'result':'not_sent'}})
        self.assertFalse(self.m.browser('carrier-recovery-check',{'page_id':page})['eligible'])
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.m.browser('pause',{'page_id':page,'paused':False,'expected_request_id':request})
        second=self.prepare(page);self.assertNotEqual(second['id'],descriptor['id'])
        self.assertEqual(second['original_attempt_id'],offer['attempt_id']);self.assertEqual(second['request_id'],request)
        with closing(self.h.state.connect()) as db:
            history=[json.loads(x[0]) for x in db.execute("SELECT data FROM events WHERE thread_id=? AND kind='managed_empty_carrier_prepared' ORDER BY seq",(self.row(page)['thread_id'],))]
            self.assertEqual(history[-1]['previous']['id'],descriptor['id'])
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',(old,)).fetchone()[0],'not_sent')
    def test_original_session_change_after_send_cannot_rebind_a_different_receiver(self):
        page,_,_=self.setup_original();descriptor=self.prepare(page);offer=self.wire(page,'pulse')
        self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':EMPTY,'prompt_hash':'a'*64})
        row=self.row(page)
        with closing(self.h.state.connect()) as db:
            spec=json.loads(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(row['thread_id'],)).fetchone()[0]);spec['session_id']='wc_sess_replaced'
            db.execute('UPDATE host_bindings SET spec=? WHERE thread_id=?',(json.dumps(spec),row['thread_id']));db.commit()
        with self.assertRaisesRegex(HarnessError,'managed_empty_carrier_identity_changed'):
            self.m.browser('bind-recovered-carrier',self.bind_payload(page,descriptor,offer['attempt_id']))
        self.assertEqual(self.row(page)['url'],descriptor['original_url'])
    def test_empty_home_and_first_turn_without_history_scroller_preserve_explicit_null(self):
        page,_,_=self.setup_original();scope=self.m.browser('carrier-recovery-check',{'page_id':page})
        descriptor=self.m.browser('recover-empty-carrier',{'page_id':page,'expected':scope,'browser':{**self.evidence(),'history_at_latest':None}})
        offer=self.wire(page,'pulse');self.wire(page,'dispatch',attempt_id=offer['attempt_id'])
        self.m.browser('prepare',{'page_id':page,'attempt_id':offer['attempt_id'],'assistant_before_hash':EMPTY,'prompt_hash':'a'*64})
        payload=self.bind_payload(page,descriptor,offer['attempt_id']);payload['browser']['history_at_latest']=None
        self.assertEqual(self.m.browser('bind-recovered-carrier',payload)['state'],'bound')

if __name__=='__main__':unittest.main()
