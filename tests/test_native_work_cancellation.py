"""Exited-turn withdrawal: real native receipt checking, isolated journal/network."""
import json
from pathlib import Path
import sqlite3
import uuid
from contextlib import closing
from unittest.mock import patch

from tests.test_native_terminal_settlement import NativeTerminalSettlementTests, THREAD, TURN
from native_work_admission import AdmissionError,status,mark_terminal,settle
from native_work_cancellation import cancel_stopped,stopped_tools,original_exited,request_cancel


class NativeStoppedCancellationTests(NativeTerminalSettlementTests):
    # Base fixtures exercise the same real receipt validator; inherited tests
    # remain ordinary terminal regression cases.
    def stopped_fixture(self):
        self.record.update(state='needs_attention',exitCode=1073807364,bridgeRuntimePid=1003)
        (self.result/'execution.json').write_text(json.dumps(self.record),encoding='utf8')
        (self.result/'final.md').unlink()
        (self.result/'events.jsonl').write_text(json.dumps({'type':'thread.started','thread_id':THREAD})+'\n'+
            json.dumps({'type':'turn.started'})+'\n',encoding='utf8')
        rows=[json.loads(line) for line in self.source.read_text().splitlines()]
        rows=[row for row in rows if row.get('payload',{}).get('type')!='task_complete' and
            row.get('payload',{}).get('phase')!='final_answer']
        self.source.write_text('\n'.join(map(json.dumps,rows)),encoding='utf8')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE native_work_claims SET state='unknown' WHERE claim_id=?",(self.claim['claim_id'],))
            db.commit()
        self.trace='123456abcdef';self.op=str(uuid.uuid4())
        home=self.root/'clw/.local/codex-web-bridge/turn-sources';home.mkdir(parents=True)
        (home/(self.trace+'.json')).write_text(json.dumps({'threadId':THREAD,'turnId':TURN,
            'traceId':self.trace,'workingDirectory':str(self.workspace)}),encoding='utf8')
        return self.root/'clw/scripts/native_work_cancellation.py'

    def run_cancel(self,fake_file,control):
        with patch('native_work_cancellation.__file__',str(fake_file)), \
             patch('native_work_cancellation.current_control',return_value=('http://127.0.0.1:12345','fake-token',1004)), \
             patch('native_work_cancellation._read_json',side_effect=control), \
             patch('native_work_cancellation.original_exited'), \
             patch('native_work_interruption.stopped_processes',return_value=True):
            return cancel_stopped(self.db,self.result,operation_id=self.op,thread_id=THREAD,
                turn_id=TURN,trace_id=self.trace)

    def test_stopped_tools_do_not_forge_native_terminal(self):
        self.stopped_fixture()
        record,proof=stopped_tools(self.row(),{'threadId':THREAD,'turnId':TURN})
        self.assertEqual(proof['returnedTools'],1)
        self.assertFalse(proof['originalNativeTerminal'])
        self.assertTrue(proof['stopped'])
        raw=self.source.read_text();self.source.write_text(raw+'\n'+json.dumps({
            'type':'response_item','timestamp':'2026-09-26T10:00:01Z','payload':{
            'type':'function_call','name':'exec_command','call_id':'unreturned',
            'arguments':json.dumps({'cmd':'unfinished'})}}))
        with self.assertRaisesRegex(AdmissionError,'stopped_tools_unverified'):
            stopped_tools(self.row(),{'threadId':THREAD,'turnId':TURN})

    def test_alive_original_bridge_blocks_withdrawal(self):
        self.stopped_fixture()
        with patch('native_work_cancellation.claim_owner_live',side_effect=[False,True]):
            with self.assertRaisesRegex(AdmissionError,'original_bridge_alive'):
                original_exited(self.row(),self.record)

    def test_settled_withdrawal_is_audited_and_idempotent(self):
        # Patch only the isolated control/source binding root; keep the real
        # helper path while native records continue under CODEX_HOME.
        fake=self.stopped_fixture()
        real=stopped_tools(self.row(),{'threadId':THREAD,'turnId':TURN})
        def control(*args,**kwargs):return {'status':'ok','cancelled_http_turns':0,
            'cancelled_browser_turns':0,'cancelled_compaction_runs':0}
        with patch('native_work_cancellation.stopped_tools',return_value=real):
            answer=self.run_cancel(fake,control)
        self.assertEqual(answer['taskOutcome'],'cancelled_unverified')
        self.assertEqual(status(self.db,self.result)['state'],'released')
        self.assertFalse(answer['originalNativeTerminal'])
        self.run_cancel(fake,lambda *a,**k:self.fail('must not repeat cancellation'))

    def test_unknown_control_delivery_is_not_replayed_or_released(self):
        fake=self.stopped_fixture();real=stopped_tools(self.row(),{'threadId':THREAD,'turnId':TURN})
        with patch('native_work_cancellation.stopped_tools',return_value=real):
            with self.assertRaises(OSError):self.run_cancel(fake,lambda *a,**k:(_ for _ in ()).throw(OSError('lost')))
        self.assertEqual(status(self.db,self.result)['state'],'unknown')
        with self.assertRaisesRegex(AdmissionError,'no_replay'):
            self.run_cancel(fake,lambda *a,**k:self.fail('must not repeat cancellation'))

    def test_targeted_running_cancel_never_releases_claim_and_reuses_receipt(self):
        fake=self.stopped_fixture();self.record['state']='running'
        (self.result/'execution.json').write_text(json.dumps(self.record),encoding='utf8')
        def invoke(control):
            with patch('native_work_cancellation.__file__',str(fake)), \
                 patch('native_work_cancellation.current_control',return_value=('http://127.0.0.1:12345','fake',1003)), \
                 patch('native_work_cancellation.claim_owner_live',return_value=True), \
                 patch('native_work_cancellation._read_json',side_effect=control):
                return request_cancel(self.db,self.result,operation_id=self.op,thread_id=THREAD,turn_id=TURN,trace_id=self.trace)
        result=invoke(lambda *a,**k:{'status':'ok','cancelled_http_turns':1,'cancelled_browser_turns':1,'cancelled_compaction_runs':0})
        self.assertFalse(result['claimReleased']);self.assertEqual(result['state'],'cancellation_requested')
        self.assertEqual(status(self.db,self.result)['state'],'unknown')
        self.assertEqual(invoke(lambda *a,**k:self.fail('no repeated revoke')),result)
        # The launcher later saves a genuine error terminal. The same original
        # command must still be matched before the acknowledged cancel releases.
        error='unexpected status 499: scoped operator cancellation'
        self.record.update(state='needs_attention',exitCode=1)
        (self.result/'execution.json').write_text(json.dumps(self.record),encoding='utf8')
        with (self.result/'events.jsonl').open('a',encoding='utf8') as f:
            f.write(json.dumps({'type':'turn.failed','error':{'message':error}})+'\n')
        with self.source.open('a',encoding='utf8') as f:
            f.write('\n'+json.dumps({'type':'event_msg','timestamp':'2026-09-26T10:00:02Z',
                'payload':{'type':'task_complete','turn_id':TURN,'error':{'message':error}}})+'\n')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE native_work_claims SET state='running' WHERE claim_id=?",(self.claim['claim_id'],));db.commit()
        mark_terminal(self.db,self.claim['claim_id'],1001)
        completed=settle(self.db,self.result)
        self.assertEqual(completed['state'],'released')
        self.assertEqual(completed['taskOutcome'],'cancelled_unverified')
        self.assertEqual(status(self.db,self.result)['recovery'],'cancelled_native_terminal')

    def test_targeted_cancel_unknown_delivery_is_not_reissued(self):
        fake=self.stopped_fixture();self.record['state']='running'
        (self.result/'execution.json').write_text(json.dumps(self.record),encoding='utf8')
        def invoke(control):
            with patch('native_work_cancellation.__file__',str(fake)), \
                 patch('native_work_cancellation.current_control',return_value=('http://127.0.0.1:12345','fake',1003)), \
                 patch('native_work_cancellation.claim_owner_live',return_value=True), \
                 patch('native_work_cancellation._read_json',side_effect=control):
                return request_cancel(self.db,self.result,operation_id=self.op,thread_id=THREAD,turn_id=TURN,trace_id=self.trace)
        with self.assertRaises(OSError):invoke(lambda *a,**k:(_ for _ in ()).throw(OSError('lost')))
        self.assertEqual(invoke(lambda *a,**k:self.fail('no replay'))['state'],'unknown')
        self.assertEqual(status(self.db,self.result)['state'],'unknown')
