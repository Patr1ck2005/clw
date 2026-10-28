"""Exercise narrowed scheduling scopes and refusal fences in temporary ledgers."""
from contextlib import closing
from pathlib import Path
import json, os, sys, unittest, uuid
sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed as fixture
from harness_state import HarnessError
from harness_team_scopes import plain_root


class NarrowScopeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.ManagedTests(); self.fixture.setUp()
        self.m, self.h = self.fixture.m, self.fixture.h
        self.root = self.fixture.f.root
        self.camp, self.sibling = self.root / 'camp', self.root / 'tenet'
        self.camp.mkdir(); self.sibling.mkdir()

    def tearDown(self): self.fixture.tearDown()

    def prepare(self, **options):
        self.page, _ = self.fixture.enroll(access='write', write_paths=['.'], **options)
        self.m.browser('pause', {'page_id': self.page, 'paused': True})
        with closing(self.h.state.connect()) as db:
            row = db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()
            self.thread = row[0]; self.old = self.h.team.scopes.scope(db, self.thread)
        self.payload = {'page_id': self.page, 'operation_id': str(uuid.uuid4()),
                        'expected_fingerprint': self.old['fingerprint'], 'root': str(self.camp),
                        'write_paths': ['.'], 'confirm': True}

    def test_siblings_stop_conflicting_without_changing_project_session(self):
        self.prepare()
        sibling = {**self.old, 'root': plain_root(str(self.sibling))}
        self.assertTrue(self.h.team.scopes.conflict(self.old, sibling))
        with closing(self.h.state.connect()) as db:
            before = db.execute('SELECT spec FROM host_bindings WHERE thread_id=?', (self.thread,)).fetchone()[0]
        result = self.m.browser('configure-write-scope', self.payload)
        with closing(self.h.state.connect()) as db:
            scope = self.h.team.scopes.scope(db, self.thread)
            after = db.execute('SELECT spec FROM host_bindings WHERE thread_id=?', (self.thread,)).fetchone()[0]
            page = db.execute('SELECT root,settings FROM managed_pages WHERE page_id=?', (self.page,)).fetchone()
        self.assertFalse(self.h.team.scopes.conflict(scope, sibling))
        self.assertTrue(self.h.team.scopes.conflict(scope, {**scope, 'root': os.path.normcase(str(self.camp / 'inside'))}))
        self.assertEqual(before, after)
        self.assertEqual(page['root'], scope['root'])
        self.assertEqual(json.loads(page['settings'])['write_paths'], ['.'])
        self.assertEqual(result['model_sends'], 0)
        self.assertEqual(self.m.browser('configure-write-scope', self.payload), result)

    def test_shared_resource_and_actual_ancestor_overlap_still_conflict(self):
        self.prepare(resources=['unity'])
        self.m.browser('configure-write-scope', self.payload)
        with closing(self.h.state.connect()) as db: scope = self.h.team.scopes.scope(db, self.thread)
        self.assertEqual(json.loads(scope['resources']), ['unity'])
        self.assertTrue(self.h.team.scopes.conflict(scope, {**scope, 'root': plain_root(str(self.sibling))}))
        self.assertTrue(self.h.team.scopes.conflict(scope, {**scope, 'root': os.path.normcase(str(self.camp / 'inside'))}))

    def test_active_original_and_changed_scope_are_rejected(self):
        self.prepare()
        self.fixture.f.s.command({'request_id': str(uuid.uuid4()), 'action': 'message.send',
                                 'thread_id': self.thread, 'data': {'text': 'unstarted original'}})
        with self.assertRaisesRegex(HarnessError, 'team_active_original_scope_cannot_change'):
            self.m.browser('configure-write-scope', self.payload)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(self.h.team.scopes.scope(db, self.thread)['fingerprint'], self.old['fingerprint'])

    def test_no_expansion_and_no_unknown_operation_replacement(self):
        self.prepare()
        with self.assertRaisesRegex(HarnessError, 'managed_scope_must_narrow'):
            self.m.browser('configure-write-scope', {**self.payload, 'root': str(self.root.parent)})
        with self.assertRaisesRegex(HarnessError, 'managed_scope_source_changed'):
            self.m.browser('configure-write-scope', {**self.payload, 'expected_fingerprint': 'changed'})
        self.m.browser('configure-write-scope', self.payload)
        with self.assertRaisesRegex(HarnessError, 'team_operation_conflict'):
            self.m.browser('configure-write-scope', {**self.payload, 'root': str(self.sibling)})

    def test_unknown_accepted_operation_keeps_its_original_scope(self):
        self.prepare()
        key = str(uuid.uuid4())
        self.fixture.f.s.command({'request_id': key, 'action':'message.send',
                                 'thread_id':self.thread, 'data':{'text':'fixture original'}})
        with closing(self.h.state.connect()) as db:
            db.execute("UPDATE host_requests SET phase='blocked' WHERE id=?", (key,))
            db.execute("UPDATE operations SET state='unknown' WHERE id=?", (key,)); db.commit()
        with self.assertRaisesRegex(HarnessError, 'attention_local_execution_unknown'):
            self.m.browser('configure-write-scope', self.payload)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(self.h.team.scopes.scope(db, self.thread)['fingerprint'], self.old['fingerprint'])


if __name__ == '__main__': unittest.main()
