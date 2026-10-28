"""Isolated record reads: pagination, exact ownership, lazy bodies, and zero writes."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed as managed_fixture
from harness_record_history import INDEX_KINDS, KINDS, MAX_BODY_BYTES, RECORD_KINDS
from harness_state import HarnessError
from test_harness_control_plane import PAGE


class RecordHistoryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = managed_fixture.ManagedTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.m, self.h = self.fixture.m, self.fixture.h
        self.page, enrolled = self.fixture.enroll()
        self.thread = enrolled['thread_id']
        self.other_page, other = self.fixture.enroll()
        self.other_thread = other['thread_id']
        with closing(self.h.state.connect()) as db:
            db.execute('DELETE FROM events')
            db.commit()

    def emit(self, kind, data, *, thread=None):
        with closing(self.h.state.connect()) as db:
            cursor = db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',
                                (thread or self.thread, kind, json.dumps(data), '2026-10-01T00:00:00Z'))
            db.commit()
            return cursor.lastrowid

    def history(self, **payload):
        return self.m.browser('record-history', {'page_id': self.page, **payload})

    def index(self, **payload):
        return self.m.browser('record-index', {'page_id': self.page, **payload})

    def save_body(self, value, *, kind='assistant_message', owner=None, request=None,
                  source='public_dom_markdown', path=None, size=None, item=None):
        raw = value.encode('utf-8') if isinstance(value, str) else value
        sha = hashlib.sha256(raw).hexdigest()
        store = self.h.state.path.parent / 'managed-results'
        store.mkdir(exist_ok=True)
        dest = path or store / (sha + '.md')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        request = request or 'saved-' + uuid.uuid4().hex
        artifact = item or 'artifact-' + uuid.uuid4().hex
        with closing(self.h.state.connect()) as db:
            if kind in ('managed_preparation_reply', 'managed_first_task_public_reply'):
                db.execute('INSERT INTO managed_preparation_results VALUES(?,?,?,?,?,?,?)',
                           (owner or self.page, 'a' * 64, 'https://chatgpt.com/c/fixture', str(dest), sha,
                            len(raw) if size is None else size, 1.0))
            else:
                db.execute('INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',
                           (artifact, request, owner or self.thread, str(dest), sha,
                            len(raw) if size is None else size, source, 1.0))
            db.commit()
        prefix = value[:1000] if isinstance(value, str) else '原稿摘要'
        marker = '完整首次准备回复：' if kind != 'assistant_message' else '完整公开原文（必须读取）：'
        data = {'text': prefix + '\n\n' + marker + str(dest) + '\nSHA256: ' + sha,
                'request_id': request, 'item_id': artifact}
        if kind != 'assistant_message':
            data.update(path=str(dest), sha256=sha, source_hash='a' * 64, url='https://chatgpt.com/c/fixture')
        return self.emit(kind, data), dest, data

    def body(self, seq):
        return self.m.browser('record-body', {'page_id': self.page, 'seq': seq})['event']

    def assert_body_unavailable(self, seq, reason, original):
        result = self.body(seq)
        self.assertTrue(result['body_unavailable'])
        self.assertEqual(result['body_unavailable_reason'], reason)
        self.assertFalse(result['body_loaded'])
        self.assertFalse(result['full_length_known'])
        self.assertTrue(result['truncated'])
        self.assertEqual(result['data'], original)
        return result

    def seed_history(self, count=145):
        own = []
        for ordinal in range(count):
            kind = 'user_message' if ordinal % 2 == 0 else 'assistant_message'
            own.append(self.emit(kind, {'text': '记录 ' + str(ordinal), 'operation_id': 'unbound-' + str(ordinal)}))
            self.emit('user_message', {'text': 'FOREIGN ' + str(ordinal)}, thread=self.other_thread)
            self.emit('not_a_public_record', {'text': 'PRIVATE ' + str(ordinal)})
        return own

    def test_more_than_100_records_first_latest_and_old_view_remain_compatible(self):
        seqs = self.seed_history()
        first = self.history(position='first')
        latest = self.history()
        self.assertEqual([event['seq'] for event in first['events']], seqs[:40])
        self.assertEqual([event['seq'] for event in latest['events']], seqs[-40:])
        self.assertEqual(first['total'], 145)
        self.assertFalse(first['has_before'])
        self.assertTrue(first['has_after'])
        self.assertTrue(latest['has_before'])
        self.assertFalse(latest['has_after'])
        self.assertEqual((first['first_seq'], first['last_seq']), (seqs[0], seqs[39]))
        self.assertEqual((latest['page_id'], latest['thread_id']), (self.page, self.thread))
        old = self.m.browser('view', {'page_id': self.page})
        self.assertEqual([event['seq'] for event in old['events']], seqs[-100:])
        self.assertNotIn('record_history', old)
        self.assertNotIn('body_loaded', old['events'][0])
        summary = self.m.browser('view', {'page_id': self.page, 'record_summaries': True})
        self.assertEqual(summary['events'], latest['events'])
        self.assertEqual(summary['record_history'], {key: latest[key] for key in
                         ('has_before', 'has_after', 'total', 'first_seq', 'last_seq')})

    def test_strict_seq_pagination_is_complete_with_gaps_and_timestamp_ties(self):
        seqs = self.seed_history()
        page = self.history(position='first')
        forward = [event['seq'] for event in page['events']]
        while page['has_after']:
            page = self.history(after_seq=page['last_seq'])
            forward.extend(event['seq'] for event in page['events'])
        self.assertEqual(forward, seqs)
        self.assertEqual(len(forward), len(set(forward)))
        page = self.history()
        backward = [event['seq'] for event in page['events']]
        while page['has_before']:
            page = self.history(before_seq=page['first_seq'])
            backward = [event['seq'] for event in page['events']] + backward
        self.assertEqual(backward, seqs)
        self.assertEqual(self.history(after_seq=seqs[-1])['events'], [])
        self.assertEqual(self.history(before_seq=seqs[0])['events'], [])

    def test_around_jump_uses_real_seq_and_fills_both_history_edges(self):
        seqs = self.seed_history()
        middle = self.history(around_seq=seqs[70])
        self.assertEqual([event['seq'] for event in middle['events']], seqs[50:90])
        self.assertTrue(middle['has_before'])
        self.assertTrue(middle['has_after'])
        self.assertEqual([event['seq'] for event in self.history(around_seq=seqs[0])['events']], seqs[:40])
        self.assertEqual([event['seq'] for event in self.history(around_seq=seqs[-1])['events']], seqs[-40:])
        self.assertEqual([event['seq'] for event in self.history(around_seq=seqs[7], limit=1)['events']], [seqs[7]])

    def test_summary_bounds_nested_raw_and_body_returns_exact_full_event(self):
        body = '开头\n' + '长正文🙂' * 5000 + '\nonly-in-full-footer'
        data = {'text': body, 'request_id': 'saved-request', 'source': 'saved_fixture',
                'raw': {'nested': 'private-raw-' * 10000}, 'oversize_metadata': 'x' * 4000}
        seq = self.emit('assistant_message', data)
        short_seq = self.emit('assistant_message', {'text': '短回复', 'source': 'saved_fixture'})
        summary, short = self.history()['events']
        self.assertEqual(summary['data']['text'], body[:600])
        self.assertEqual(summary['text_length'], len(body))
        self.assertTrue(summary['truncated'])
        self.assertFalse(summary['body_loaded'])
        self.assertNotIn('raw', summary['data'])
        self.assertNotIn('oversize_metadata', summary['data'])
        self.assertLess(len(json.dumps(summary, ensure_ascii=False)), 2400)
        self.assertTrue(short['body_loaded'])
        self.assertFalse(short['truncated'])
        full = self.m.browser('record-body', {'page_id': self.page, 'seq': seq})
        self.assertEqual(full['event']['data'], data)
        self.assertEqual(full['event']['seq'], seq)
        self.assertNotIn('body_loaded', full['event'])
        self.assertEqual(self.m.browser('record-body', {'page_id': self.page, 'seq': short_seq})['event']['data']['text'], '短回复')
        self.assertEqual(self.index(query='only-in-full-footer')['items'][0]['seq'], seq)

    def test_registered_full_artifact_is_lazy_on_poll_and_restored_for_body_and_search(self):
        full = '已保存原稿\n' + '完整正文🙂' * 12000 + '\nartifact-only-search-footer'
        seq, path, original = self.save_body(full)
        with patch('harness_record_history._saved_body', side_effect=AssertionError('poll opened original body')):
            summary = self.history()['events'][0]
            self.index()
            self.m.browser('view', {'page_id': self.page, 'record_summaries': True})
        self.assertFalse(summary['body_loaded'])
        self.assertFalse(summary['full_length_known'])
        self.assertEqual(summary['body_bytes'], len(full.encode('utf-8')))
        self.assertLessEqual(len(summary['data']['text']), 600)
        result = self.body(seq)
        self.assertEqual(result['data']['text'], full)
        self.assertTrue(result['body_loaded'])
        self.assertTrue(result['full_length_known'])
        self.assertEqual(result['text_length'], len(full))
        self.assertFalse(result['truncated'])
        found = self.index(query='artifact-only-search-footer')
        self.assertEqual([item['seq'] for item in found['items']], [seq])
        self.assertEqual(found['unavailable_body_count'], 0)
        old = self.m.browser('view', {'page_id': self.page})['events'][0]
        self.assertEqual(old['data'], original)
        self.assertEqual(path.read_text(encoding='utf-8'), full)

    def test_preparation_reply_and_recovered_closed_summary_restore_original_registered_text(self):
        full = '首次准备\n' + 'z' * 60000 + '\npreparation-full-footer'
        seq, _, _ = self.save_body(full, kind='managed_preparation_reply')
        self.assertEqual(self.body(seq)['data']['text'], full)
        self.assertEqual(self.index(query='preparation-full-footer')['items'][0]['seq'], seq)
        closed = '已回收总结\n' + 'y' * 50000 + '\nclosed-summary-full-footer'
        item = 'closed-summary-original-request'
        _, path, _ = self.save_body(closed, request='original-request', item=item,
                                    source='authenticated_team_final_summary')
        seq = self.emit('assistant_message', {'text': closed[:46000],
                        'request_id': 'original-request', 'item_id': item})
        self.assertEqual(self.body(seq)['data']['text'], closed)
        self.assertIn(seq, [item['seq'] for item in self.index(query='closed-summary-full-footer')['items']])
        self.assertEqual(path.stat().st_size, len(closed.encode('utf-8')))

    def test_equal_length_inline_preparation_text_requires_original_content_hash(self):
        original_text = 'a' * 1000
        _, _, pointer = self.save_body(original_text, kind='managed_preparation_reply')
        correct = {**pointer, 'text': original_text}
        correct_seq = self.emit('managed_preparation_reply', correct)
        wrong = {**pointer, 'text': 'b' * 1000}
        wrong_seq = self.emit('managed_preparation_reply', wrong)
        with patch('harness_record_history._saved_body', side_effect=AssertionError('verified inline body opened file')):
            self.assertEqual(self.body(correct_seq)['data']['text'], original_text)
        restored = self.body(wrong_seq)
        self.assertEqual(restored['data']['text'], original_text)
        self.assertTrue(restored['body_loaded'])
        self.assertTrue(restored['full_length_known'])
        self.assertFalse(restored['truncated'])
        self.assertIn(wrong_seq, [item['seq'] for item in self.index(query='a' * 200)['items']])
        self.assertNotIn(wrong_seq, [item['seq'] for item in self.index(query='b' * 200)['items']])

    def test_bom_inline_preparation_text_requires_bom_and_content_hash(self):
        original_text = '带 BOM 的完整回复🙂' * 70
        raw = b'\xef\xbb\xbf' + original_text.encode('utf-8')
        _, path, pointer = self.save_body(raw, kind='managed_preparation_reply')
        correct_seq = self.emit('managed_preparation_reply', {**pointer, 'text': original_text})
        with patch('harness_record_history._saved_body', side_effect=AssertionError('verified BOM inline opened file')):
            self.assertEqual(self.body(correct_seq)['data']['text'], original_text)
        wrong_text = original_text.replace('完整', '错误')
        self.assertEqual(len(wrong_text.encode('utf-8')), len(original_text.encode('utf-8')))
        wrong_seq = self.emit('managed_preparation_reply', {**pointer, 'text': wrong_text})
        self.assertEqual(self.body(wrong_seq)['data']['text'], original_text)
        path.write_bytes(b'\xef\xbb\xbf' + wrong_text.encode('utf-8'))
        self.assert_body_unavailable(wrong_seq, 'hash_mismatch', {**pointer, 'text': wrong_text})

    def test_inline_body_revision_changes_when_length_and_preview_are_identical(self):
        prefix = 'p' * 600
        first = {'text': prefix + 'x' * 1000, 'request_id': 'saved-request'}
        seq = self.emit('assistant_message', first)
        old = self.history()['events'][0]
        self.assertEqual(self.body(seq)['body_revision'], old['body_revision'])
        self.assertRegex(old['body_revision'], '^[0-9a-f]{64}$')
        changed = {**first, 'text': prefix + 'y' * 1000}
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE events SET data=? WHERE seq=?', (json.dumps(changed), seq))
            db.commit()
        new = self.history()['events'][0]
        self.assertEqual(new['data']['text'], old['data']['text'])
        self.assertEqual(new['text_length'], old['text_length'])
        self.assertNotEqual(new['body_revision'], old['body_revision'])
        self.assertEqual(self.body(seq)['body_revision'], new['body_revision'])
        self.assertEqual(self.body(seq)['data']['text'], changed['text'])
        short_seq = self.emit('assistant_message', {'text': 'short reply'})
        short = next(event for event in self.history()['events'] if event['seq'] == short_seq)
        self.assertTrue(short['body_loaded'])
        self.assertRegex(short['body_revision'], '^[0-9a-f]{64}$')

    def test_artifact_body_revision_changes_with_registered_binding_without_poll_file_reads(self):
        prefix = 'p' * 600
        seq, _, first = self.save_body(prefix + 'x' * 60000, request='same-original-request')
        old = self.history()['events'][0]
        self.assertEqual(self.body(seq)['body_revision'], old['body_revision'])
        _, _, changed = self.save_body(prefix + 'y' * 60000, request='same-original-request')
        with closing(self.h.state.connect()) as db:
            db.execute('UPDATE events SET data=? WHERE seq=?', (json.dumps(changed), seq))
            db.commit()
        with patch('harness_record_history._saved_body', side_effect=AssertionError('revision poll opened artifact')):
            new = next(event for event in self.history()['events'] if event['seq'] == seq)
        self.assertEqual(new['data']['text'], old['data']['text'])
        self.assertEqual(new['text_length'], old['text_length'])
        self.assertEqual(new['body_bytes'], old['body_bytes'])
        self.assertNotEqual(new['body_revision'], old['body_revision'])
        self.assertEqual(self.body(seq)['body_revision'], new['body_revision'])
        self.assertEqual(self.body(seq)['data']['text'], prefix + 'y' * 60000)

    def test_missing_changed_and_invalid_utf8_artifacts_preserve_original_summary(self):
        seq, path, original = self.save_body('original missing body\n' + 'a' * 50000)
        path.unlink()
        self.assert_body_unavailable(seq, 'missing', original)
        seq, path, original = self.save_body('original changed body\n' + 'b' * 50000)
        raw = path.read_bytes()
        path.write_bytes(b'X' + raw[1:])
        self.assert_body_unavailable(seq, 'hash_mismatch', original)
        seq, _, original = self.save_body(b'\xffinvalid utf8')
        self.assert_body_unavailable(seq, 'invalid_utf8', original)
        missing = self.index(query='not-present-anywhere')
        self.assertEqual(missing['items'], [])
        self.assertEqual(missing['unavailable_body_count'], 3)

    def test_artifact_registration_ownership_request_and_identity_are_exact(self):
        for kwargs in ({'owner': self.other_thread}, {'source': 'public_dom_partial_send'}):
            seq, _, original = self.save_body('foreign body\n' + 'x' * 50000, **kwargs)
            self.assert_body_unavailable(seq, 'identity_mismatch', original)
        seq, path, original = self.save_body('request-owned body\n' + 'r' * 50000)
        wrong_request = {**original, 'request_id': 'another-request'}
        other_seq = self.emit('assistant_message', wrong_request)
        self.assert_body_unavailable(other_seq, 'identity_mismatch', wrong_request)
        conflicting = {**original, 'path': str(path), 'sha256': 'b' * 64}
        conflicting_seq = self.emit('assistant_message', conflicting)
        self.assert_body_unavailable(conflicting_seq, 'identity_mismatch', conflicting)
        self.assertTrue(self.body(seq)['body_loaded'])
        full = 'preparation-owned\n' + 'p' * 50000
        seq, _, original = self.save_body(full, kind='managed_preparation_reply', owner=self.other_page)
        self.assert_body_unavailable(seq, 'identity_mismatch', original)

    def test_artifact_path_escape_and_symlink_escape_never_read_external_file(self):
        full = 'outside store body\n' + 'o' * 50000
        sha = hashlib.sha256(full.encode()).hexdigest()
        outside = self.fixture.f.root / 'outside' / (sha + '.md')
        seq, _, original = self.save_body(full, path=outside)
        with patch.object(Path, 'open', side_effect=AssertionError('outside file opened')):
            self.assert_body_unavailable(seq, 'path_outside_store', original)
        full = 'symlink outside body\n' + 's' * 50000
        seq, path, original = self.save_body(full)
        outside = self.fixture.f.root / 'outside' / path.name
        outside.write_bytes(path.read_bytes())
        path.unlink()
        try:
            path.symlink_to(outside)
        except OSError:
            return  # Windows installations may not grant temporary symlink creation.
        with patch.object(Path, 'open', side_effect=AssertionError('symlink outside file opened')):
            self.assert_body_unavailable(seq, 'path_outside_store', original)

    def test_body_size_boundary_and_registered_size_mismatch_are_explicit(self):
        seq, _, original = self.save_body('declared too large', size=MAX_BODY_BYTES + 1)
        with patch.object(Path, 'open', side_effect=AssertionError('oversize file opened')):
            self.assert_body_unavailable(seq, 'too_large', original)
        seq, path, original = self.save_body('actual too large')
        with path.open('wb') as source:
            source.truncate(MAX_BODY_BYTES + 1)
        self.assert_body_unavailable(seq, 'too_large', original)
        seq, _, original = self.save_body('size mismatch', size=100)
        self.assert_body_unavailable(seq, 'size_mismatch', original)
        full = 'x' * MAX_BODY_BYTES
        seq, _, _ = self.save_body(full)
        self.assertEqual(self.body(seq)['data']['text'], full)

    def test_index_lists_requirements_and_replies_and_search_is_literal_and_thread_owned(self):
        seqs = []
        for ordinal in range(95):
            kind = INDEX_KINDS[ordinal % len(INDEX_KINDS)]
            seqs.append(self.emit(kind, {'text': f'条目 {ordinal}\n第二行'}))
            self.emit('host_result', {'status': 'completed'})
        self.assertEqual([item['seq'] for item in self.index(position='first')['items']], seqs[:40])
        latest = self.index()
        self.assertEqual([item['seq'] for item in latest['items']], seqs[-40:])
        self.assertEqual(latest['total'], len(seqs))
        self.assertEqual(set(latest['items'][0]), {'seq', 'kind', 'at', 'label'})
        self.assertNotIn('\n', latest['items'][0]['label'])
        for query in ('100%_literal', "' OR 1=1 --", '中文精确'):
            seq = self.emit('assistant_message', {'text': 'prefix ' + query + ' suffix'})
            self.emit('assistant_message', {'text': query}, thread=self.other_thread)
            self.assertEqual([item['seq'] for item in self.index(query=query)['items']], [seq])
        self.assertEqual(self.index(query='NO MATCH')['items'], [])
        self.assertEqual(self.index(query='NO MATCH')['total'], 0)
        for item in self.index(limit=80)['items']:
            self.assertLessEqual(len(item['label']), 120)

    def test_search_pagination_is_complete_and_includes_record_text_outside_directory(self):
        seqs = [self.emit('host_turn_attention', {'text': 'matching saved attention ' + str(i)}) for i in range(91)]
        self.assertEqual(self.index()['total'], 0)
        page = self.index(query='matching', position='first')
        found = [item['seq'] for item in page['items']]
        while page['has_after']:
            page = self.index(query='matching', after_seq=page['last_seq'])
            found.extend(item['seq'] for item in page['items'])
        self.assertEqual(found, seqs)

    def test_body_and_cursors_cannot_read_another_thread_or_hidden_event(self):
        seq = self.emit('assistant_message', {'text': 'own'})
        foreign = self.emit('assistant_message', {'text': 'foreign'}, thread=self.other_thread)
        hidden = self.emit('not_a_public_record', {'text': 'hidden'})
        for bad_seq in (foreign, hidden, hidden + 100):
            with self.subTest(seq=bad_seq):
                with self.assertRaisesRegex(HarnessError, 'managed_record_event_missing'):
                    self.m.browser('record-body', {'page_id': self.page, 'seq': bad_seq})
                for key in ('around_seq', 'before_seq', 'after_seq'):
                    with self.assertRaisesRegex(HarnessError, 'managed_record_event_missing'):
                        self.history(**{key: bad_seq})
        with self.assertRaises(HarnessError):
            self.m.browser('record-body', {'page_id': self.other_page, 'seq': seq})
        with self.assertRaisesRegex(HarnessError, 'managed_page_missing'):
            self.m.browser('record-history', {'page_id': self.page + '-wrong'})

    def test_read_connection_does_not_acquire_write_lock_or_use_mutating_connection(self):
        seq = self.emit('assistant_message', {'text': 'stored body'})
        statements = []
        connections = []
        original_connect = sqlite3.connect

        def readonly_connect(*args, **kwargs):
            self.assertIn('?mode=ro', args[0])
            self.assertTrue(kwargs['uri'])
            db = original_connect(*args, **kwargs)
            db.set_trace_callback(statements.append)
            connections.append(args[0])
            return db

        class RejectLock:
            def __enter__(self):
                raise AssertionError('record read acquired shared write lock')
            def __exit__(self, *_):
                pass

        original_lock = self.h.lock
        self.h.lock = RejectLock()
        try:
            with patch.object(self.h.state, 'connect', side_effect=AssertionError('shared connection')), \
                    patch('harness_record_history.sqlite3.connect', side_effect=readonly_connect):
                self.history()
                self.index()
                self.m.browser('record-body', {'page_id': self.page, 'seq': seq})
        finally:
            self.h.lock = original_lock
        self.assertEqual(len(connections), 3)
        self.assertTrue(all(sql.lstrip().startswith(('SELECT', 'BEGIN')) for sql in statements), statements)
        self.assertNotIn('BEGIN IMMEDIATE', statements)

    def test_repeated_reads_do_not_acknowledge_unread_notes_or_change_database(self):
        request = self.fixture.f.command(self.thread, 'message.send', {'text': 'goal'})['request_id']
        self.fixture.f.command(self.thread, 'message.append', {'text': 'unread note', 'expected_request_id': request})
        with closing(self.h.state.connect()) as db:
            before = '\n'.join(db.iterdump())
            seq = db.execute("SELECT seq FROM events WHERE kind='host_user_note'").fetchone()[0]
        before_hash = hashlib.sha256(self.h.state.path.read_bytes()).hexdigest()
        for _ in range(2):
            events = self.history()['events']
            note = next(event for event in events if event['kind'] == 'host_user_note')
            self.assertEqual(note['delivery'], 'queued_note')
            self.assertIsNotNone(note['withdraw'])
            self.index()
            full = self.m.browser('record-body', {'page_id': self.page, 'seq': seq})
            self.assertEqual(full['event']['delivery'], 'queued_note')
        with closing(self.h.state.connect()) as db:
            self.assertEqual('\n'.join(db.iterdump()), before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM managed_next_round_notes').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_unread_notes').fetchone()[0], 0)
        self.assertEqual(hashlib.sha256(self.h.state.path.read_bytes()).hexdigest(), before_hash)
        self.assertEqual(self.fixture.f.bridge.posts, [])

    def test_delivery_and_withdrawn_filter_match_legacy_projection(self):
        request = self.fixture.f.command(self.thread, 'message.send', {'text': 'goal'})['request_id']
        self.fixture.f.command(self.thread, 'message.append', {'text': 'note', 'expected_request_id': request})
        before = self.history()
        goal = next(event for event in before['events'] if event['kind'] == 'user_message')
        self.assertEqual(goal['delivery'], 'queued')
        self.assertEqual(goal['withdraw'], {'request_id': request})
        offer = self.fixture.wire(self.page, 'pulse')
        self.m.browser('pause', {'page_id': self.page, 'paused': True})
        self.m.browser('withdraw', {'page_id': self.page, 'request_id': request})
        old = self.m.browser('view', {'page_id': self.page})
        history = self.history()
        self.assertEqual(history['total'], len(old['events']))
        self.assertFalse(any(event['kind'] == 'host_queued' for event in history['events']))
        for event in history['events']:
            body = self.m.browser('record-body', {'page_id': self.page, 'seq': event['seq']})['event']
            body.pop('body_revision')
            self.assertEqual(body,
                             next(old_event for old_event in old['events'] if old_event['seq'] == event['seq']))
        self.assertEqual([event['delivery'] for event in history['events'] if event['kind'] in
                          ('user_message', 'host_user_note')], ['withdrawn', 'withdrawn'])
        queued_seq = next(event['seq'] for event in before['events'] if event['kind'] == 'host_queued')
        with self.assertRaises(HarnessError):
            self.m.browser('record-body', {'page_id': self.page, 'seq': queued_seq})

    def test_confirming_delivered_and_read_note_are_shared_with_full_body(self):
        request = self.fixture.f.command(self.thread, 'message.send', {'text': 'goal'})['request_id']
        offer = self.fixture.wire(self.page, 'pulse')
        self.fixture.wire(self.page, 'dispatch', attempt_id=offer['attempt_id'])
        self.assertEqual(next(event for event in self.history()['events'] if event['kind'] == 'user_message')['delivery'], 'confirming')
        self.fixture.wire(self.page, 'sent', attempt_id=offer['attempt_id'],
                          page={**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高',
                                'user_hash': 'b' * 64, 'generating': True}, assistant_before_hash='c' * 64)
        self.fixture.f.command(self.thread, 'message.append', {'text': 'note', 'expected_request_id': request})
        self.assertEqual(next(event for event in self.history()['events'] if event['kind'] == 'user_message')['delivery'], 'delivered')
        self.fixture.private(self.page, 'context', {})
        self.assertEqual(next(event for event in self.history()['events'] if event['kind'] == 'host_user_note')['delivery'], 'queued_note')

    def test_new_history_includes_first_task_reply_without_changing_old_kinds(self):
        seq = self.emit('managed_first_task_public_reply', {'text': 'original first-task reply'})
        self.assertNotIn('managed_first_task_public_reply', KINDS)
        self.assertIn('managed_first_task_public_reply', RECORD_KINDS)
        self.assertEqual(self.m.browser('view', {'page_id': self.page})['events'], [])
        self.assertEqual(self.history()['events'][0]['seq'], seq)
        self.assertEqual(self.index()['items'][0]['seq'], seq)

    def test_empty_reserved_page_and_input_bounds_are_explicit(self):
        self.assertEqual(self.history()['total'], 0)
        self.assertEqual(self.history()['events'], [])
        self.assertIsNone(self.history()['first_seq'])
        self.assertFalse(self.history()['has_before'])
        self.assertFalse(self.history()['has_after'])
        reserved, _ = self.fixture.reserve()
        empty = self.m.browser('record-history', {'page_id': reserved})
        self.assertIsNone(empty['thread_id'])
        self.assertEqual(empty['total'], 0)
        self.seed_history(85)
        self.assertEqual(len(self.history(limit=80)['events']), 80)
        for bad in (0, -1, 81, True, '40', 1.5, None):
            with self.subTest(limit=bad), self.assertRaises(HarnessError):
                self.history(limit=bad)
        for bad in (0, -1, True, '1', 1.5, None, 2**63):
            with self.subTest(seq=bad), self.assertRaises(HarnessError):
                self.m.browser('record-body', {'page_id': self.page, 'seq': bad})
        for bad in ('', ' ' + self.page, self.page + ' ', None, True, 'x' * 161):
            with self.subTest(page_id=bad), self.assertRaises(HarnessError):
                self.m.browser('record-history', {'page_id': bad})
        for bad in ('middle', None, True):
            with self.subTest(position=bad), self.assertRaises(HarnessError):
                self.history(position=bad)
        for bad in (None, True, [], '\x00', 'x' * 1001):
            with self.subTest(query=bad), self.assertRaises(HarnessError):
                self.index(query=bad)
        for fields in ({'before_seq': 1, 'after_seq': 2}, {'around_seq': 1, 'before_seq': 2},
                       {'unknown_field': True}):
            with self.subTest(fields=fields), self.assertRaises(HarnessError):
                self.history(**fields)
        with self.assertRaises(HarnessError):
            self.index(around_seq=1)
        with self.assertRaises(HarnessError):
            self.m.browser('view', {'page_id': self.page, 'record_summaries': 'true'})


if __name__ == '__main__':
    unittest.main()
