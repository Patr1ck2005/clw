import json,sys,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from read_codex_web_task import inspect

class NativeEvidenceTests(unittest.TestCase):
    def test_excessive_json_depth_is_unknown_and_does_not_crash_record_reading(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'execution.json').write_text(json.dumps({'state':'turn_completed','exitCode':0}))
            (root/'events.jsonl').write_text('['*1500+'0'+']'*1500,encoding='utf8')
            result=inspect(root,sessions=root/'absent')
            self.assertEqual(result['eventReadIssue'],'malformed_event_record')
            self.assertEqual(result['nativeWorkCompletionEvidence']['state'],'unavailable')
            (root/'execution.json').write_text('['*1500+'0'+']'*1500,encoding='utf8')
            with self.assertRaisesRegex(ValueError,'native_execution_receipt_invalid'):inspect(root)
    def test_bad_cli_record_shapes_preserve_transport_and_mark_reading_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'execution.json').write_text(json.dumps({'state':'turn_completed','exitCode':0}))
            (root/'events.jsonl').write_text('\n'.join(json.dumps(value) for value in
                ([],None,7,{'type':'thread.started','thread_id':7},{'type':'item.completed','item':[]},{'type':'turn.failed','error':None})),encoding='utf8')
            result=inspect(root,sessions=root/'absent')
            self.assertEqual(result['state'],'turn_completed')
            self.assertEqual(result['eventReadIssue'],'malformed_event_record')
            self.assertEqual(result['nativeWorkCompletionEvidence']['state'],'unavailable')
            self.assertFalse(result['nativeWorkCompletionEvidence']['claimReleaseAuthorized'])

    def test_bad_native_record_shapes_are_unavailable_without_crashing_inspection(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);sessions=root/'sessions';day=sessions/'2026/09/25';day.mkdir(parents=True)
            thread='01a0dc76-19a6-7310-8cde-c533d66e3a06'
            (root/'execution.json').write_text(json.dumps({'state':'running','startedAt':'2026-09-26T06:45:20Z'}))
            (root/'events.jsonl').write_text(json.dumps({'type':'thread.started','thread_id':thread}))
            source=day/('rollout-fixture-'+thread+'.jsonl')
            for value in (None,[],{'type':'response_item','payload':[]}):
                source.write_text(json.dumps(value),encoding='utf8')
                self.assertEqual(inspect(root,sessions=sessions)['nativeSessionEvidence']['state'],'unavailable')
    def test_audited_interruption_is_not_left_running_or_marked_success(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            original=json.dumps({'state':'running','admissionId':'original','ownerPid':123456})
            (root/'execution.json').write_text(original,encoding='utf8')
            with patch('read_codex_web_task.admission_status',return_value={
                    'state':'released','recovery':'interrupted_connection_failure'}):
                result=inspect(root)
            self.assertEqual(result['state'],'interrupted')
            self.assertEqual(result['taskAcceptance'],'unverified')
            self.assertFalse(result['automaticReplay'])
            self.assertEqual((root/'execution.json').read_text('utf8'),original)

    def test_native_image_missing_from_cli_and_time_bounded_resume(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);packet=root/'packet';packet.mkdir();sessions=root/'sessions';day=sessions/'2026/09/25';day.mkdir(parents=True)
            thread='01a0dc76-19a6-7310-8cde-c533d66e3a06'
            row={'state':'turn_completed','startedAt':'2026-09-26T06:45:20Z','endedAt':'2026-09-26T06:48:08Z'}
            (packet/'execution.json').write_text(json.dumps(row));(packet/'events.jsonl').write_text(json.dumps({'type':'thread.started','thread_id':thread})+'\n')
            def event(at,kind,call,name=None):
                p={'type':kind,'call_id':call,'arguments':'SECRET','output':'PRIVATE'}
                if name:p['name']=name
                return {'timestamp':at,'type':'response_item','payload':p}
            data=[{'type':'session_meta','payload':{'id':thread}},
                  event('2026-09-26T06:44:00Z','function_call','old','exec_command'),
                  event('2026-09-26T06:47:03Z','function_call','image','view_image'),
                  event('2026-09-26T06:47:04Z','function_call_output','image'),
                  event('2026-09-26T06:49:00Z','function_call','future','apply_patch')]
            (day/('rollout-fixture-'+thread+'.jsonl')).write_text('\n'.join(json.dumps(x) for x in data)+'\n{partial',encoding='utf8')
            result=inspect(packet,sessions=sessions);proof=result['nativeSessionEvidence'];self.assertEqual(proof['state'],'observed')
            self.assertEqual(proof['tools'],{'view_image':{'invocations':1,'returned':1}})
            self.assertFalse(proof['executionAbsenceProven']);self.assertEqual(result['taskAcceptance'],'unverified')
            self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('PRIVATE',json.dumps(result))

    def test_missing_or_mismatched_native_session_is_unknown_not_no_execution(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'running','startedAt':'2026-09-26T06:45:20Z'}))
            (root/'events.jsonl').write_text('')
            result=inspect(root,sessions=root/'absent');self.assertEqual(result['nativeSessionEvidence']['state'],'unavailable')
            self.assertFalse(result['nativeSessionEvidence']['executionAbsenceProven'])

    def test_reported_refusal_is_not_transport_failure_or_verified_platform_decision(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'completed','exitCode':0}))
            (root/'final.md').write_text('> 因 OpenAI 无法确定请求的安全状态，已拦截此工具调用。\nPRIVATE_TASK_TEXT',encoding='utf8')
            result=inspect(root,sessions=root/'absent')
            self.assertEqual(result['state'],'turn_completed');self.assertEqual(result['taskAcceptance'],'unverified')
            self.assertEqual(result['reviewStatus'],'reported_blocker_requires_review')
            report=result['reportedBlockers'][0]
            self.assertEqual(report['code'],'platform_safety_block_reported')
            self.assertEqual(report['evidence'],'reported_not_independently_verified')
            self.assertFalse(report['automaticRetry']);self.assertNotIn('PRIVATE_TASK_TEXT',json.dumps(result))

    def test_duplicate_report_is_separate_and_general_safety_mentions_do_not_trigger(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'completed'}))
            (root/'final.md').write_text('409 Duplicate active request ID',encoding='utf8')
            self.assertEqual(inspect(root)['reportedBlockers'][0]['code'],'duplicate_active_request_reported')
            (root/'final.md').write_text('没有遇到平台安全拒绝。Discuss safety checks and duplicate requests.',encoding='utf8')
            self.assertEqual(inspect(root)['reportedBlockers'],[])

    def test_expired_turn_report_does_not_authorize_a_retry(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'turn_completed'}))
            (root/'final.md').write_text('turn token is invalid, expired, or revoked',encoding='utf8')
            result=inspect(root)
            self.assertEqual(result['reportedBlockers'][0]['code'],'native_turn_authority_ended_reported')
            self.assertFalse(result['reportedBlockers'][0]['automaticRetry'])
            self.assertEqual(result['taskAcceptance'],'unverified')

    def test_discovery_mismatch_is_not_reported_as_a_safety_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'turn_completed'}))
            for message in ("unknown model-visible runtime tool 'codex_tool_call'",r"unknown model-visible runtime tool 'codex\_tool\_call'",'No tool was defined under the given paths'):
                (root/'final.md').write_text(message,encoding='utf8')
                reports=inspect(root)['reportedBlockers']
                self.assertEqual([r['code'] for r in reports],['tool_discovery_unavailable_reported'])
                self.assertFalse(reports[0]['automaticRetry'])

    def test_offline_connector_report_is_not_a_platform_safety_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'execution.json').write_text(json.dumps({'state':'turn_completed'}))
            (root/'final.md').write_text('404 Not Found，ERR\\_NGROK\\_3200：对应 MCP endpoint offline。',encoding='utf8')
            result=inspect(root)
            self.assertEqual([r['code'] for r in result['reportedBlockers']],['connector_endpoint_offline_reported'])
            self.assertEqual(result['reviewStatus'],'reported_blocker_requires_review')
            self.assertFalse(result['reportedBlockers'][0]['automaticRetry'])

if __name__=='__main__':unittest.main()
