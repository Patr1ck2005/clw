"""Isolated branch actors: protocol evidence only, not real browser subagents."""
from pathlib import Path
from contextlib import closing
import copy,json,sys,tempfile,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from harness_service import HarnessService
from harness_state import HarnessError
from harness_host import read_local_key
from test_harness_service import FakeConnection
from test_harness_web import CONFIG,FakeBridge


def uid():return str(uuid.uuid4())

class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.bridge=FakeBridge();self.bridge.denied=True
        self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=copy.deepcopy(CONFIG),web_bridge=self.bridge)
        self.sessions={'main':CONFIG['targets'][0]['session_id'],'child-a':'wc_sess_qqqqqqqqqqqqqqqq','child-b':'wc_sess_rrrrrrrrrrrrrrrr','grandchild':'wc_sess_ssssssssssssssss'}
        self.key=read_local_key(self.root/'state');self.parent=self.p('main','register',confirm=True)['thread'];self.claim=uid()
    def tearDown(self):self.s.close();self.temp.cleanup()
    def p(self,target,action,**data):
        return self.s.host_bridge.private(self.key,dict(action=action,target_id=target,session_id=self.sessions[target],store_id=self.s.state.id,**data))
    def command(self,thread,action,data=None,key=None):
        return self.s.command(dict(request_id=key or uid(),thread_id=thread,action=action,data=data or {}))
    def join(self,child='child-a',parent='main'):
        return self.p(child,'join',parent_target_id=parent,title='独立分支 '+child,confirm=True)['thread']
    def start(self):
        r=self.command(self.parent['id'],'message.send',{'text':'原始完整目标'})
        self.p('main','claim',request_id=r['request_id'],claim_id=self.claim);return r['request_id']
    def delegate(self,r,child='child-a',key=None,claim=None,text='独立检查'):
        return self.p('main','delegate',request_id=r,claim_id=claim or self.claim,child_target_id=child,delegation_id=key or uid(),text=text)
    def yield_parent(self,r):return self.p('main','yield',request_id=r,claim_id=self.claim)
    def poll(self,target):return self.p(target,'poll',wait_key='wait-'+target+'-fixed-key-0001')
    def finish(self,target,r,claim,text='分支真实回执（隔离测试）'):
        return self.p(target,'reply',request_id=r,claim_id=claim,reply_id=uid(),status='completed',text=text)
    def test_join_uses_independent_session_and_preserves_parent(self):
        child=self.join();self.assertEqual(child['parent_id'],self.parent['id']);self.assertEqual(self.join()['id'],child['id'])
        self.assertEqual(self.p('main','branches')['children'][0]['session_id'],self.sessions['child-a'])
        self.assertIsNone(self.s.connection);self.assertEqual(self.bridge.posts,[])
    def test_same_session_cannot_impersonate_child(self):
        self.sessions['child-a']=self.sessions['main']
        with self.assertRaises(HarnessError):self.join()
        self.assertEqual(len(self.s.state.listing()),1)
    def test_join_different_parent_cannot_reassign_history(self):
        self.join();self.join('child-b')
        with self.assertRaises(HarnessError):self.join('child-a','child-b')
    def test_no_fake_join_from_browser_command(self):
        with self.assertRaises(HarnessError):self.command(self.parent['id'],'host.join',{})
    def test_delegate_yield_child_result_resumes_original_parent_request(self):
        child=self.join();r=self.start();d=self.delegate(r);c=uid()
        self.assertFalse(self.poll('child-a')['available'])
        with self.assertRaises(HarnessError):self.p('child-a','claim',request_id=d['child_request_id'],claim_id=c)
        self.yield_parent(r);self.assertTrue(self.poll('child-a')['available']);self.assertFalse(self.poll('main')['available'])
        received=self.p('child-a','claim',request_id=d['child_request_id'],claim_id=c)
        self.assertEqual(received['delegation']['parent_request_id'],r)
        self.finish('child-a',d['child_request_id'],c)
        self.assertEqual(self.poll('main')['request_id'],r)
        resumed=self.p('main','claim',request_id=r,claim_id=self.claim)
        self.assertTrue(resumed['already_claimed']);self.assertEqual(resumed['text'],'原始完整目标')
        results=self.p('main','results',request_id=r,claim_id=self.claim)
        self.assertEqual(results['children'][0]['phase'],'completed');self.assertIn('隔离测试',results['children'][0]['reply_excerpt'])
        self.assertFalse(results['parent_completed']);self.finish('main',r,self.claim)
    def test_same_checkout_children_are_serial_not_false_parallelism(self):
        self.join();self.join('child-b');r=self.start();a=self.delegate(r);b=self.delegate(r,'child-b');self.yield_parent(r)
        ca,cb=uid(),uid();self.p('child-a','claim',request_id=a['child_request_id'],claim_id=ca)
        with self.assertRaises(HarnessError):self.p('child-b','claim',request_id=b['child_request_id'],claim_id=cb)
        self.finish('child-a',a['child_request_id'],ca);self.assertFalse(self.poll('main')['available'])
        self.p('child-b','claim',request_id=b['child_request_id'],claim_id=cb);self.finish('child-b',b['child_request_id'],cb)
        self.assertTrue(self.poll('main')['available'])
    def test_duplicate_delegation_returns_same_child_and_changed_replay_rejected(self):
        self.join();r=self.start();key=uid();first=self.delegate(r,key=key)
        self.assertEqual(first,self.delegate(r,key=key))
        with self.assertRaises(HarnessError):self.delegate(r,key=key,text='changed')
        self.assertEqual(len(self.p('main','results',request_id=r,claim_id=self.claim)['children']),1)
    def test_parent_cannot_finalize_with_pending_children(self):
        self.join();r=self.start();self.delegate(r)
        with self.assertRaises(HarnessError):self.finish('main',r,self.claim)
        self.assertEqual(self.p('main','read',request_id=r)['phase'],'processing')
    def test_wrong_parent_claim_and_nonchild_rejected(self):
        self.join();r=self.start()
        with self.assertRaises(HarnessError):self.delegate(r,claim=uid())
        with self.assertRaises(HarnessError):self.delegate(r,child='not-joined')
    def test_child_paused_cannot_receive_delegation(self):
        child=self.join();r=self.start();self.command(child['id'],'host.pause')
        with self.assertRaises(HarnessError):self.delegate(r)
    def test_recover_parent_requires_original_claim_and_all_children(self):
        self.join();r=self.start();d=self.delegate(r);self.yield_parent(r)
        with self.assertRaises(HarnessError):self.p('main','claim',request_id=r,claim_id=uid())
        with self.assertRaises(HarnessError):self.p('main','claim',request_id=r,claim_id=self.claim)
    def test_restart_retains_branch_request_and_delegation(self):
        child=self.join();r=self.start();d=self.delegate(r);self.yield_parent(r);old=self.s.state.id;self.s.close()
        self.s=HarnessService(self.root,self.root/'state',connection_factory=FakeConnection,web_targets=copy.deepcopy(CONFIG),web_bridge=self.bridge)
        self.assertEqual(self.s.state.id,old);self.assertEqual(self.join()['id'],child['id'])
        self.assertEqual(self.poll('child-a')['request_id'],d['child_request_id'])
        self.assertEqual(self.p('main','read',request_id=r)['phase'],'suspended')
    def test_notes_same_request_not_second_turn_and_deduplicated(self):
        r=self.start();key=uid();body={'text':'新增条件','expected_request_id':r}
        first=self.command(self.parent['id'],'message.append',body,key)
        self.assertEqual(first,self.command(self.parent['id'],'message.append',body,key))
        read=self.p('main','read',request_id=r);self.assertEqual(len(read['additional_instructions']),1)
        self.assertEqual(read['text'],'原始完整目标');self.assertIsNone(self.s.connection)
    def test_paused_original_accepts_notes_but_unknown_request_is_rejected(self):
        r=self.start()
        wrong=self.command(self.parent['id'],'message.append',{'text':'note','expected_request_id':uid()})
        self.assertEqual(wrong['state'],'rejected')
        self.command(self.parent['id'],'host.pause')
        paused=self.command(self.parent['id'],'message.append',{'text':'note','expected_request_id':r})
        self.assertEqual(paused['state'],'note_saved_not_native_interrupt')
    def test_pause_parent_holds_queued_children_without_cancelling_originals(self):
        child=self.join();r=self.start();d=self.delegate(r);self.yield_parent(r)
        self.command(self.parent['id'],'host.pause')
        self.assertEqual(self.p('child-a','read',request_id=d['child_request_id'])['phase'],'queued')
        self.assertFalse(self.poll('child-a')['available'])
        self.assertFalse(self.p('main','read',request_id=r)['cancel_requested'])
        self.assertTrue(next(x for x in self.s.host_bridge.snapshot()['bindings'] if x['target_id']=='child-a')['enabled'])
        self.command(self.parent['id'],'host.resume');self.assertEqual(self.poll('child-a')['request_id'],d['child_request_id'])
    def test_pause_propagates_to_nested_processing_without_fake_stop(self):
        self.join();self.join('grandchild','child-a');r=self.start();a=self.delegate(r);self.yield_parent(r);ca,cg=uid(),uid()
        self.p('child-a','claim',request_id=a['child_request_id'],claim_id=ca)
        g=self.p('child-a','delegate',request_id=a['child_request_id'],claim_id=ca,child_target_id='grandchild',delegation_id=uid(),text='检查孙分支')
        self.p('child-a','yield',request_id=a['child_request_id'],claim_id=ca)
        self.p('grandchild','claim',request_id=g['child_request_id'],claim_id=cg)
        self.command(self.parent['id'],'host.pause')
        viewed=self.p('grandchild','read',request_id=g['child_request_id'])
        self.assertFalse(viewed['cancel_requested']);self.assertEqual(viewed['phase'],'processing')
        self.finish('grandchild',g['child_request_id'],cg)
    def test_codex_cannot_begin_while_parent_yielded(self):
        self.join();r=self.start();self.delegate(r);self.yield_parent(r)
        other=self.s.state.bind('fixture-other','other',self.root)
        denied=self.command(other['id'],'message.send',{'text':'write'})
        self.assertEqual(denied['code'],'workspace_busy_or_unreconciled');self.assertIsNone(self.s.connection)
    def test_old_child_reply_cannot_finalize_parent_or_new_request(self):
        self.join();r=self.start();d=self.delegate(r);self.yield_parent(r);c=uid()
        self.p('child-a','claim',request_id=d['child_request_id'],claim_id=c);self.finish('child-a',d['child_request_id'],c)
        self.assertEqual(self.p('main','read',request_id=r)['phase'],'suspended')
    def test_unjoined_target_and_scope_changes_are_not_adopted(self):
        with self.assertRaises(HarnessError):self.p('child-b','poll',wait_key=uid())
        self.s.host_bridge.targets['main']['project']='different'
        with self.assertRaises(HarnessError):self.join()
    def test_note_budget_bounded_and_literal_html_retained(self):
        r=self.start();raw='<script>not executed</script>'
        self.command(self.parent['id'],'message.append',{'text':raw,'expected_request_id':r})
        self.assertEqual(self.p('main','read',request_id=r)['additional_instructions'][0]['text'],raw)
        for _ in range(4):self.command(self.parent['id'],'message.append',{'text':'x'*16000,'expected_request_id':r})
        result=self.command(self.parent['id'],'message.append',{'text':'y'*16000,'expected_request_id':r})
        self.assertEqual(result['code'],'host_note_budget')
    def test_title_has_only_one_provider_prefix(self):
        self.assertFalse(self.parent['title'].startswith('ChatGPT Web · ChatGPT Web'))
    def test_source_authorization_is_not_repaired_by_local_branch(self):
        self.join();self.start();self.assertEqual(self.bridge.checks,0);self.assertEqual(self.bridge.posts,[])

if __name__=='__main__':unittest.main(verbosity=2)
