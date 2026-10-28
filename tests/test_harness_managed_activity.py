"""Session-scoped Local-MCP activity is metadata, not a task tool receipt."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from harness_managed_activity import session_activity


class SessionActivityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='clw-session-activity-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.log = self.root / '.local' / 'codex-web-bridge' / 'mcp-activity.jsonl'
        self.log.parent.mkdir(parents=True)
        self.session = 'wc_sess_private_session'
        self.created = datetime.now(timezone.utc).timestamp() - 2

    def record(self, call_id, tool, event, *, session=None, at=None, **extra):
        return {'at': (at or datetime.now(timezone.utc)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                'callId': call_id, 'tool': tool, 'event': event, 'route': 'webcodex',
                'sessionHash': sha256((session or self.session).encode()).hexdigest(), **extra}

    def test_only_bound_session_metadata_is_projected_without_sensitive_values(self):
        own = '8a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        other = '0a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        rows = [self.record(other, 'read_files', 'mcp_call_started', session='another_session'),
                self.record(other, 'apply_text_edits', 'mcp_call_started', at=old),
                self.record(own, 'read_files', 'mcp_call_started', arguments={'path': 'private.txt'}),
                self.record(own, 'read_files', 'mcp_call_finished', httpStatus=200,
                            applicationSuccess=True, itemFailureCount=1, isError=False, result={'text': 'secret'})]
        self.log.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        result = session_activity(self.root, self.session, self.created)
        self.assertEqual([row['event'] for row in result['events']],
                         ['mcp_call_started', 'mcp_call_finished'])
        self.assertEqual(result['events'][-1]['applicationSuccess'], True)
        self.assertEqual(result['events'][-1]['itemFailureCount'], 1)
        self.assertEqual(result['turnAttribution'], 'unavailable')
        serialized = json.dumps(result)
        for secret in (self.session, 'private.txt', 'secret', 'sessionHash'):
            self.assertNotIn(secret, serialized)
        for row in result['events']:
            self.assertNotIn('arguments', row)
            self.assertNotIn('result', row)

    def test_truncated_or_incomplete_journal_is_explicit_and_never_fabricates_success(self):
        call = '9a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        row = self.record(call, 'run_process', 'mcp_call_started')
        self.log.write_bytes(b'x' * (128 * 1024) + b'\n' + json.dumps(row).encode() + b'\n' + b'{partial')
        result = session_activity(self.root, self.session, self.created)
        self.assertTrue(result['windowTruncated'])
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['events'][0]['event'], 'mcp_call_started')
        self.assertNotIn('applicationSuccess', result['events'][0])

    def test_bound_discovery_status_and_runtime_gateway_calls_are_visible(self):
        tools = ('tool_manifest', 'runtime_status', 'call_runtime_tool')
        rows = [self.record(f'{index:08d}-1111-4111-8111-111111111111', tool, 'mcp_call_started')
                for index, tool in enumerate(tools)]
        self.log.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        result = session_activity(self.root, self.session, self.created)
        self.assertEqual([row['tool'] for row in result['events']], list(tools))

    def test_details_references_are_scoped_and_unavailable_original_bytes_are_explicit(self):
        call = '8a7cf8d1-d6bb-4cd2-8314-3c02c9f2c7f0'
        reference = 'result_' + 'a' * 32
        folder = self.log.parent / 'result-cache' / reference
        folder.mkdir(parents=True)
        (folder / 'meta.json').write_text('{}', encoding='utf-8')
        rows = [self.record(call, 'read_files', 'mcp_call_started'),
                self.record(call, 'read_files', 'mcp_call_details', part='arguments', resultId=reference, complete=True),
                self.record(call, 'read_files', 'mcp_call_details', part='response', code='call_details_storage_unavailable')]
        self.log.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        details = session_activity(self.root, self.session, self.created)['events'][0]['details']
        self.assertTrue(details['arguments']['available'])
        self.assertEqual(details['arguments']['result_id'], reference)
        self.assertFalse(details['response']['available'])
        self.assertEqual(details['response']['reason'], 'call_details_storage_unavailable')


if __name__ == '__main__':
    unittest.main()
