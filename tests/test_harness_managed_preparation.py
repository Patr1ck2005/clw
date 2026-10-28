"""First-turn preparation uses a real enrollment receipt but no fake task claim."""
from pathlib import Path
from contextlib import closing
import sys,json,re,uuid,unittest,hashlib
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
import test_harness_managed as fixture
from harness_state import HarnessError
from harness_managed import ManagedPages


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ManagedTests();self.f.setUp();self.m=self.f.m
    def tearDown(self):self.f.tearDown()
    def receiver(self,**settings):
        page,r=self.f.reserve(**settings);self.f.sessions[page]='wc_sess_'+uuid.uuid4().hex
        reply=self.f.private(page,'enroll',{'ticket':re.search(r'clwm_[A-Za-z0-9_-]{43}',r['bootstrap_text'])[0],
                                          'project':'own-project','root':str(self.f.f.root)})
        return page,r,reply
    def test_preparation_stays_in_first_prompt_and_requires_complete_public_provenance(self):
        task='读取 HANDOFF.md；梳理证据与并发角色。'
        page,res,reply=self.receiver(first_turn_instructions=task)
        self.assertIn(task,res['bootstrap_text']);self.assertNotIn('仅接入，',res['bootstrap_text'])
        content='# 准备结果\n\n$$a^2+b^2=c^2$$\n\n```python\nprint("ok")\n```\n\n[交接](HANDOFF.md)\n'+reply['browser_marker']
        p={'page_id':page,'url':'https://chatgpt.com/c/own','public_text':content}
        with self.assertRaisesRegex(HarnessError,'managed_preparation_reply_required'):self.m.browser('bind',p)
        self.assertEqual(self.m.browser('list',{})['pages'][0]['phase'],'receiver_enrolled')
        p.update(preparation_markdown=content,source_hash='a'*64)
        self.m.browser('pause',{'page_id':page,'paused':True})
        self.m.browser('bind',p)
        # Persisted restart and duplicate bind do not invent a second event/send.
        restarted=ManagedPages(self.f.h);restarted.browser('bind',p)
        row=restarted.browser('list',{})['pages'][0]
        self.assertEqual(row['phase'],'bound');self.assertTrue(row['paused'])
        saved=row['preparation_result'];self.assertEqual(Path(saved['path']).read_bytes(),content.encode())
        self.assertEqual(saved['sha256'],hashlib.sha256(content.encode()).hexdigest())
        with closing(self.f.h.state.connect()) as db:
            events=list(db.execute("SELECT kind,data FROM events WHERE kind LIKE 'managed_preparation_%'"))
            self.assertEqual(len(events),2)
            self.assertFalse(json.loads(events[-1]['data'])['task_completed'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM control_attempts').fetchone()[0],0)
        with self.assertRaisesRegex(HarnessError,'managed_preparation_result_conflict'):
            restarted.browser('bind',{**p,'preparation_markdown':content+' changed'})
        ctx=self.f.private(page,'context',{})
        self.assertEqual(ctx['preparation_result']['sha256'],saved['sha256'])
    def test_first_turn_request_is_opt_in_and_worker_model_choice_is_explicit(self):
        parent,_=self.f.enroll(model='GPT-6 · 最新',effort='Pro',model_selection={'model':'GPT-6 · 最新','effort':'Pro'},
                             bootstrap_model_selection={'model':'GPT-5.6 · 最新','effort':'极高'})
        plain,_=self.f.reserve(parent)
        prepared,_=self.f.reserve(parent,first_turn_instructions='读取你负责的证据，形成评审问题。')
        rows={r['page_id']:r for r in self.m.browser('list',{})['pages']}
        self.assertEqual(rows[plain]['bootstrap_model_selection']['effort'],'极高')
        self.assertEqual(rows[prepared]['bootstrap_model_selection']['effort'],'极高')
        self.assertEqual(rows[prepared]['effort'],'pro')
        self.assertTrue(rows[prepared]['work_model_pending'])
        self.assertEqual(rows[plain]['first_turn_instructions'],'')
        self.assertNotIn('读取你负责的证据',rows[plain]['bootstrap_text'])
        for value in ([],None,'x'*24001):
            with self.subTest(value=type(value)),self.assertRaises(HarnessError):self.f.reserve(parent,first_turn_instructions=value)

    def test_bare_pro_enrollment_cannot_send_but_selected_substantive_preparation_can(self):
        for preparation in ('','读取交接并准备角色'):
            page,_=self.f.reserve(model='GPT-6 · 最新',effort='Pro',first_turn_instructions=preparation)
            if not preparation:
                with self.assertRaisesRegex(HarnessError,'managed_pro_enrollment_not_allowed_use_extra_high'):
                    self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':{'model':'GPT-6 · 最新','effort':'Pro'}})
            else:
                self.m.browser('bootstrap-model-ready',{'page_id':page,'model_selection':{'model':'GPT-6 · 最新','effort':'Pro'}})
            row=next(r for r in self.m.browser('list',{})['pages'] if r['page_id']==page)
            self.assertEqual(row['bootstrap_state'],'pending')
    def test_long_original_is_not_flattened_or_truncated_in_artifact(self):
        page,_,reply=self.receiver(first_turn_instructions='读取交接')
        content=('公式 $x_1$ 与代码 `x = 1`\n'*4000)+reply['browser_marker']
        self.m.browser('bind',{'page_id':page,'url':'https://chatgpt.com/c/long','public_text':reply['browser_marker'],
                              'preparation_markdown':content,'source_hash':'b'*64})
        row=self.m.browser('list',{})['pages'][0]
        self.assertEqual(Path(row['preparation_result']['path']).read_bytes(),content.encode())

if __name__=='__main__':unittest.main()
