"""Actual local HTTP + CLI entry points with isolated actors, never real models."""
from pathlib import Path
from contextlib import closing, redirect_stdout
from unittest.mock import patch
from io import StringIO
import json, sys, threading, unittest, uuid
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
import test_harness_collaboration as fixtures
import harness_host_client as cli
from harness_state import HarnessError
from harness_http import HarnessHTTP
from serve_control_center import create_server
from urllib.request import build_opener, ProxyHandler

class BranchAPITests(unittest.TestCase):
    setUp=fixtures.CollaborationTests.setUp;tearDown=fixtures.CollaborationTests.tearDown
    p=fixtures.CollaborationTests.p;command=fixtures.CollaborationTests.command
    join=fixtures.CollaborationTests.join;start=fixtures.CollaborationTests.start
    delegate=fixtures.CollaborationTests.delegate;yield_parent=fixtures.CollaborationTests.yield_parent
    finish=fixtures.CollaborationTests.finish;poll=fixtures.CollaborationTests.poll

    def note(self,r,text='additional condition'):
        return self.command(self.parent['id'],'message.append',{'text':text,'expected_request_id':r})
    def result(self,r,d,after=0):
        return self.p('main','result',request_id=r,claim_id=self.claim,delegation_id=d['delegation_id'],after_seq=after)
    def test_new_note_blocks_final_until_real_receiver_read(self):
        r=self.start();self.note(r)
        with self.assertRaisesRegex(HarnessError,'host_new_instructions_read_before_final'):self.finish('main',r,self.claim)
        self.assertEqual(self.p('main','read',request_id=r)['additional_instructions'][0]['text'],'additional condition')
        self.finish('main',r,self.claim)
    def test_late_note_after_read_requires_new_read_not_old_snapshot(self):
        r=self.start();self.note(r,'first');self.p('main','read',request_id=r);self.note(r,'second')
        with self.assertRaises(HarnessError):self.finish('main',r,self.claim)
        v=self.p('main','read',request_id=r);self.assertEqual([x['text'] for x in v['additional_instructions']],['first','second'])
        self.finish('main',r,self.claim)
    def test_progress_and_browser_poll_do_not_acknowledge_notes(self):
        r=self.start();self.note(r)
        self.p('main','reply',request_id=r,claim_id=self.claim,reply_id=str(uuid.uuid4()),status='progress',text='working')
        self.s.host_bridge.public_branch_state(self.parent['id'])
        with self.assertRaises(HarnessError):self.finish('main',r,self.claim)
    def test_cancelled_completion_does_not_require_read_of_notes(self):
        r=self.start();self.note(r);self.s.host_bridge.pause(self.parent['id'],False)
        self.p('main','reply',request_id=r,claim_id=self.claim,reply_id=str(uuid.uuid4()),status='cancelled',text='stopped')
    def test_result_pages_are_full_public_replies_of_exact_child(self):
        self.join();r=self.start();d=self.delegate(r);self.yield_parent(r);claim=str(uuid.uuid4())
        self.p('child-a','claim',request_id=d['child_request_id'],claim_id=claim)
        self.p('child-a','reply',request_id=d['child_request_id'],claim_id=claim,reply_id=str(uuid.uuid4()),status='progress',text='progress')
        full='详细论证：'+('正确范围与限定；'*3000)
        self.finish('child-a',d['child_request_id'],claim,full)
        a=self.result(r,d);self.assertEqual(len(a['items']),1);self.assertTrue(a['has_more']);self.assertEqual(a['items'][0]['data']['text'],'progress')
        b=self.result(r,d,a['next_after']);self.assertFalse(b['has_more']);self.assertEqual(b['items'][0]['data']['text'],full)
        self.assertEqual(self.result(r,d,b['next_after'])['items'],[])
        summary=self.p('main','results',request_id=r,claim_id=self.claim)['children'][0]
        self.assertTrue(summary['reply_truncated']);self.assertLess(len(summary['reply_excerpt']),len(full))
    def test_summary_is_not_lost_after_200_unrelated_messages(self):
        self.join();r=self.start();d=self.delegate(r);self.yield_parent(r);claim=str(uuid.uuid4())
        self.p('child-a','claim',request_id=d['child_request_id'],claim_id=claim);self.finish('child-a',d['child_request_id'],claim,'original result')
        for i in range(205):self.s.state.event(d['child_thread_id'],'assistant_message',{'request_id':'later-unrelated-request','text':str(i)})
        self.assertEqual(self.p('main','results',request_id=r,claim_id=self.claim)['children'][0]['reply_excerpt'],'original result')
    def test_result_rejects_wrong_parent_and_bad_cursor(self):
        self.join();r=self.start();d=self.delegate(r)
        for after in (-1,True,'0'):
            with self.assertRaises(HarnessError):self.result(r,d,after)
        with self.assertRaises(HarnessError):self.result(r,{'delegation_id':str(uuid.uuid4())})
    def test_branch_projection_does_not_reveal_claim_or_key(self):
        self.join();r=self.start();self.delegate(r)
        v=self.s.host_bridge.public_branch_state(self.parent['id']);text=json.dumps(v)
        self.assertEqual(v['results']['pending_children'],1);self.assertNotIn(self.claim,text);self.assertNotIn(self.key,text)
        self.assertFalse(v['native_browser_fork'])
    def test_notes_survive_restart_without_resetting_acknowledgement(self):
        r=self.start();self.note(r);self.p('main','read',request_id=r)
        from harness_collaboration import HostCollaboration
        self.s.host_bridge.collaboration=HostCollaboration(self.s.host_bridge)
        self.finish('main',r,self.claim)
    def test_cli_and_http_join_delegate_yield_receive_result(self):
        server=create_server(0);server.harness_api=HarnessHTTP(self.s)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        origin='http://127.0.0.1:'+str(server.server_address[1]);client=cli.Client
        def invoke(target,action,*extra):
            args=['harness_host_client.py',action,'--store-id',self.s.state.id,'--target',target,'--session-id',self.sessions[target],*extra]
            out=StringIO()
            with patch.object(sys,'argv',args),patch.object(cli,'Client',lambda _o,_s,store,trg,sess:client(origin,self.root/'state',store,trg,sess)),redirect_stdout(out):
                self.assertEqual(cli.main(),0)
            return json.loads(out.getvalue())
        try:
            child=invoke('child-a','join','--parent-target','main','--title','Independent review','--confirm')
            self.assertTrue(child['joined']);self.assertFalse(child['model_created'])
            self.assertEqual(len(invoke('main','branches')['children']),1)
            r=self.start();uid=str(uuid.uuid4());text=self.root/'delegate.md';text.write_text('review independently',encoding='utf-8')
            with patch.object(cli,'ROOT',self.root):
                d=invoke('main','delegate','--request-id',r,'--claim-id',self.claim,'--child-target','child-a','--delegation-id',uid,'--text-file','delegate.md')
            invoke('main','yield','--request-id',r,'--claim-id',self.claim)
            claim=str(uuid.uuid4());self.p('child-a','claim',request_id=d['child_request_id'],claim_id=claim);self.finish('child-a',d['child_request_id'],claim,'independent result')
            full=invoke('main','result','--request-id',r,'--claim-id',self.claim,'--delegation-id',uid)
            self.assertEqual(full['items'][0]['data']['text'],'independent result')
            with build_opener(ProxyHandler({})).open(origin+'/api/harness/branches?thread_id='+self.parent['id']) as response:view=json.loads(response.read())
            self.assertEqual(view['results']['children'][0]['phase'],'completed')
            self.assertIsNone(self.s.connection)
        finally:server.shutdown();server.server_close();t.join()

if __name__=='__main__':unittest.main(verbosity=2)
