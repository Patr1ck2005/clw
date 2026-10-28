"""Narrow attach uses an isolated existing store; no live service or model."""
from contextlib import ExitStack, closing
from dataclasses import asdict, replace
import json
import io
import os
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch
import uuid

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_paused_branch_reconcile as fixtures
import harness_operator_attach as operator
from harness_state import HarnessError


class OperatorAttachTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PausedBranchTests(); self.fixture.setUp()
        self.ctx, self.child, self.request, self.old, self.offer, self.payload = self.fixture.setup_branch()
        self.root = self.fixture.h.root.resolve()
        self.path = self.root / '.local' / 'harness' / 'harness.sqlite3'
        self.path.parent.mkdir(parents=True)
        # Retained production-shaped schema and state, at the required root
        # location. Its setup is completed before attachment starts.
        with closing(self.fixture.h.state.connect()) as source, closing(sqlite3.connect(self.path)) as target:
            source.backup(target)
        self.identity = operator.AttachIdentity(
            root=str(self.root), state_path=str(self.path), store_id=self.fixture.h.state.id,
            controller_thread=self.ctx['request']['thread_id'],
            controller_session=self._controller_session(),
            run_id=self.ctx['run']['id'], origin='http://127.0.0.1:18944',
            harness_instance_id='retained-instance', pid=85116, process_start='windows-filetime:1234')
        self.live = {'harness': {'success': True, 'root': str(self.root), 'store_id': self.identity.store_id,
                                 'instance_id': self.identity.harness_instance_id}}
        self.raw = {'request_id': str(uuid.uuid4()), 'action': 'team.reconcile-attention',
                    'thread_id': self.identity.controller_thread, 'data': self.payload}
        self.game_ids = self._seed_game()

    def tearDown(self):
        self.fixture.tearDown()

    def _controller_session(self):
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',
                             (self.ctx['request']['thread_id'],)).fetchone()
        return json.loads(row[0])['session_id']

    def attach(self, identity=None, **kwargs):
        return operator.attach_existing(identity or self.identity,
            live_probe=kwargs.get('live_probe', lambda origin: self.live),
            process_probe=kwargs.get('process_probe', lambda pid: self.identity.process_start))

    def _seed_game(self):
        threads, operations = [], []
        with closing(sqlite3.connect(self.path)) as db:
            for n, (status, state) in enumerate((('working', 'reserved'), ('stopping', 'dispatching'))):
                thread, op = 'hthr_game_' + str(n), 'game-operation-' + str(n)
                threads.append(thread); operations.append(op)
                db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (thread, 'codex', 'native-game-' + str(n), None, 'Unrelated current game',
                     str(self.root), 'gpt-6.1-sol', 'high', status, 'original-game-turn', 'old', 'old'))
                db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',
                    (op, 'retained-fingerprint', 'message.send', thread, state, None, 'old'))
            db.execute('INSERT INTO web_outbox VALUES(?,?,?,?,?,?,?)',
                ('retained-web-outbox', threads[0], 'Original game work', '{}', 'dispatching', None, 'dispatching'))
            db.commit()
        return threads, operations

    def snapshot(self):
        with closing(sqlite3.connect(self.path)) as db:
            return {name: db.execute('SELECT * FROM "' + name + '" ORDER BY rowid').fetchall()
                    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}

    def game(self):
        with closing(sqlite3.connect(self.path)) as db:
            return {'threads': db.execute("SELECT * FROM threads WHERE id LIKE 'hthr_game_%' ORDER BY id").fetchall(),
                    'operations': db.execute("SELECT * FROM operations WHERE id LIKE 'game-operation-%' ORDER BY id").fetchall(),
                    'outbox': db.execute('SELECT * FROM web_outbox').fetchall()}

    def test_attach_constructs_no_normal_runtime_and_changes_no_sql_or_files(self):
        before, files = self.snapshot(), sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob('*'))
        statements, changes = [], []
        original_connect = sqlite3.connect

        def traced(*args, **kwargs):
            db = original_connect(*args, **kwargs)
            db.set_trace_callback(statements.append); changes.append(db)
            return db

        targets = ('harness_state.HarnessState.__init__', 'harness_service.HarnessService.__init__',
                   'harness_host.HostBridge.__init__', 'harness_team.TeamRuntime.__init__',
                   'harness_web.NativeWeb.__init__', 'harness_managed.ManagedPages.__init__',
                   'harness_collaboration.HostCollaboration.__init__', 'threading.Thread.start', 'os.open')
        with ExitStack() as stack:
            for target in targets:
                stack.enter_context(patch(target, side_effect=AssertionError('normal startup forbidden')))
            stack.enter_context(patch.object(operator.sqlite3, 'connect', side_effect=traced))
            attached = self.attach()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob('*')), files)
        self.assertTrue(statements)
        self.assertTrue(all(s.lstrip().upper().startswith(('SELECT', 'PRAGMA TABLE_INFO')) for s in statements))
        self.assertFalse(hasattr(attached._service, 'connection'))
        for method in ('connect', 'close', 'start_web_observer'):
            with self.assertRaisesRegex(HarnessError, 'operator_attach_runtime_action_forbidden'):
                getattr(attached._service, method)()
        for method in ('start', 'close', 'tick'):
            with self.assertRaises(HarnessError): getattr(attached._service.host_bridge.team, method)()
        self.assertEqual(self.snapshot(), before)

    def test_command_reuses_original_service_and_team_receipts_without_touching_game(self):
        before = self.game(); attached = self.attach()
        service_method, team_method = operator.HarnessService.command, operator.TeamRuntime.handle
        calls, statements = [], []
        original_connect = sqlite3.connect

        def traced(*args, **kwargs):
            db = original_connect(*args, **kwargs)
            db.set_trace_callback(statements.append)
            return db

        def service(service, raw): calls.append('service'); return service_method(service, raw)
        def team(team, *args, **kwargs): calls.append('team'); return team_method(team, *args, **kwargs)

        with patch.object(operator.HarnessService, 'command', service), patch.object(operator.TeamRuntime, 'handle', team), \
                patch.object(operator.sqlite3, 'connect', side_effect=traced):
            result = attached.command(self.raw)
            self.assertEqual(result['state'], 'paused_branch_retired')
            self.assertEqual(result['model_sends'], 0)
            self.assertEqual(attached.command(self.raw), result)
        self.assertEqual(calls, ['service', 'team', 'service'])
        self.assertEqual(sum(s.upper() == 'BEGIN IMMEDIATE' for s in statements), 3)
        self.assertEqual(self.game(), before)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_receipts WHERE operation_id=?',
                                        (self.raw['request_id'],)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_paused_branch_retired'").fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (self.request,)).fetchone()[0], 'blocked')

    def test_narrow_host_keeps_original_admission_count_and_sealed_exit_guard(self):
        attached = self.attach(); host = attached._service.host_bridge
        self.assertIsNone(host.maintenance_exit_fence)
        self.assertEqual(host.active_business_operations, 0)
        with self.assertRaisesRegex(ValueError, 'original admitted failure'):
            with host.business_admission():
                self.assertEqual(host.active_business_operations, 1)
                with host.business_admission():
                    self.assertEqual(host.active_business_operations, 2)
                    raise ValueError('original admitted failure')
        self.assertEqual(host.active_business_operations, 0)
        host.seal_maintenance('original-exit-permit')
        before = self.snapshot()
        with patch.object(operator.HarnessState, 'begin', side_effect=AssertionError('sealed Host must reject before reservation')):
            with self.assertRaisesRegex(HarnessError, 'maintenance_original_host_shutdown_pending'):
                attached.command(self.raw)
        self.assertEqual(host.maintenance_exit_fence, 'original-exit-permit')
        self.assertEqual(host.active_business_operations, 0)
        self.assertEqual(self.snapshot(), before)

    def test_lost_outer_reply_recovers_original_durable_receipt_after_reattach(self):
        attached = self.attach(); original_handle = operator.TeamRuntime.handle

        def lost(team, *args, **kwargs):
            original_handle(team, *args, **kwargs)
            raise ConnectionError('reply dropped after original team commit')

        with patch.object(operator.TeamRuntime, 'handle', lost):
            result = attached.command(self.raw)
        self.assertEqual(result['state'], 'unknown')
        reattached = self.attach()
        receipt = reattached.receipt(self.raw['request_id'])
        self.assertTrue(receipt['derived_from_original_team_receipt'])
        self.assertEqual(receipt['result']['state'], 'paused_branch_retired')
        self.assertEqual(reattached.command(self.raw)['state'], 'paused_branch_retired')
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='managed_paused_branch_retired'").fetchone()[0], 1)

    def test_forbidden_action_mode_actor_and_run_rejected_before_state_begin(self):
        attached = self.attach(); before = self.snapshot()
        bad = [dict(self.raw, action='provider.connect'), dict(self.raw, action='team.resume'),
               dict(self.raw, thread_id='foreign-thread'),
               dict(self.raw, data={**self.payload, 'mode': 'continue'}),
               dict(self.raw, data={**self.payload, 'confirm': False}),
               dict(self.raw, data={**self.payload, 'run_id': 'foreign-run'})]
        with patch.object(operator.HarnessState, 'begin', side_effect=AssertionError('must reject before reservation')):
            for raw in bad:
                with self.subTest(raw=raw), self.assertRaises(HarnessError): attached.command(raw)
        self.assertEqual(self.snapshot(), before)

    def test_missing_schema_store_root_or_foreign_controller_refuses_attachment_without_write(self):
        before = self.snapshot()
        for identity in (replace(self.identity, store_id='different-store'),
                         replace(self.identity, controller_session='foreign-session'),
                         replace(self.identity, controller_thread='foreign-thread'),
                         replace(self.identity, state_path=str(self.root / 'state' / 'harness.sqlite3')),
                         replace(self.identity, root=str(self.root.parent)),
                         replace(self.identity, root='relative-root')):
            with self.subTest(identity=identity), self.assertRaises(HarnessError): self.attach(identity)
        self.assertEqual(self.snapshot(), before)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('DROP TABLE managed_handoffs'); db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(HarnessError, 'operator_attach_schema_missing:managed_handoffs'): self.attach()
        self.assertEqual(self.snapshot(), before)

    def test_issue_schema_requires_kind_and_detail_without_attempting_migration(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('DROP TABLE managed_page_issues')
            db.execute('CREATE TABLE managed_page_issues(page_id TEXT PRIMARY KEY)'); db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(HarnessError, 'operator_attach_schema_missing:managed_page_issues'):
            self.attach()
        self.assertEqual(self.snapshot(), before)

    def test_control_preparation_issue_is_retained_during_zero_send_retirement(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('INSERT INTO managed_page_issues VALUES(?,?,?)',
                       (self.child, 'control_failed', '发送准备3次失败：control_user_turn_changed'))
            db.commit()
            before_issue = db.execute('SELECT * FROM managed_page_issues').fetchall()
            before_pause = db.execute('SELECT * FROM managed_pause_owners').fetchall()
            before_dispatch = db.execute('SELECT * FROM host_team_dispatches').fetchall()
            before_lease = db.execute('SELECT * FROM host_team_leases').fetchall()
        before_game = self.game()
        attached = self.attach()
        result = attached.command(self.raw)
        self.assertEqual(result['state'], 'paused_branch_retired')
        self.assertEqual(result['model_sends'], 0)
        self.assertEqual(result['preserved_page_issue'], {
            'page_id': self.child, 'kind': 'control_failed',
            'detail': '发送准备3次失败：control_user_turn_changed'})
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT * FROM managed_page_issues').fetchall(), before_issue)
            self.assertEqual(db.execute('SELECT * FROM managed_pause_owners').fetchall(), before_pause)
            self.assertEqual(db.execute('SELECT * FROM host_team_dispatches').fetchall(), before_dispatch)
            self.assertEqual(db.execute('SELECT * FROM host_team_leases').fetchall(), before_lease)
            self.assertEqual(db.execute('SELECT paused FROM managed_pages WHERE page_id=?', (self.child,)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT state,dispatched,acknowledged FROM control_attempts WHERE id=?',
                                       (self.offer['attempt_id'],)).fetchone(), ('not_sent', None, None))
        self.assertEqual(self.game(), before_game)

    def test_other_page_issue_refuses_retirement_and_preserves_the_original_fault(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('INSERT INTO managed_page_issues VALUES(?,?,?)',
                       (self.child, 'user_stopped', 'Original explicit user stop'))
            db.commit()
            before = db.execute('SELECT * FROM managed_page_issues').fetchall()
        attached = self.attach()
        result = attached.command(self.raw)
        self.assertEqual(result['state'], 'rejected')
        self.assertEqual(result['code'], 'attention_page_issue_preserved')
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT * FROM managed_page_issues').fetchall(), before)
            self.assertEqual(db.execute('SELECT phase FROM host_requests WHERE id=?', (self.request,)).fetchone()[0], 'suspended')
            self.assertEqual(db.execute('SELECT state FROM control_attempts WHERE id=?',
                                       (self.offer['attempt_id'],)).fetchone()[0], 'offered')

    def test_live_identity_and_pid_start_rechecked_before_reservation(self):
        attached = self.attach(); before = self.snapshot()
        self.live['harness']['instance_id'] = 'replacement-instance'
        with self.assertRaisesRegex(HarnessError, 'operator_attach_harness_identity_mismatch'): attached.command(self.raw)
        self.live['harness']['instance_id'] = self.identity.harness_instance_id
        attached._process_probe = lambda pid: 'windows-filetime:replacement'
        with self.assertRaisesRegex(HarnessError, 'operator_attach_process_changed'): attached.command(self.raw)
        self.assertEqual(self.snapshot(), before)

    def test_new_contract_enters_strict_gate_and_conflicting_key_cannot_replay(self):
        attached = self.attach()
        bad = dict(self.raw, data={**self.payload, 'offered_attempt_id': 'foreign-offer-000000'})
        result = attached.command(bad)
        self.assertEqual(result['state'], 'rejected')
        self.assertEqual(result['code'], 'paused_branch_offer_not_unsent')
        with self.assertRaisesRegex(HarnessError, 'request_id_conflict'): attached.command(self.raw)
        good = dict(self.raw, request_id=str(uuid.uuid4()))
        self.assertEqual(attached.command(good)['state'], 'paused_branch_retired')
        again = dict(self.raw, request_id=str(uuid.uuid4()))
        self.assertEqual(attached.command(again)['state'], 'rejected')
        self.assertEqual(self.game()['threads'][0][8], 'working')

    def test_receipt_has_original_controller_ownership(self):
        attached = self.attach(); before = self.snapshot()
        for key in ('game-operation-0', 'game-operation-1', 'missing-receipt-000'):
            with self.assertRaisesRegex(HarnessError, 'operator_attach_receipt_not_owned'): attached.receipt(key)
        self.assertEqual(self.snapshot(), before)

    def test_identity_json_is_exact_and_origin_cannot_redirect_to_remote(self):
        self.assertEqual(operator.AttachIdentity.from_dict(asdict(self.identity)), self.identity)
        with self.assertRaises(HarnessError): operator.AttachIdentity.from_dict({**asdict(self.identity), 'token': 'unused'})
        with self.assertRaises(HarnessError): self.attach(replace(self.identity, pid=True))
        for origin in ('https://127.0.0.1:18944', 'http://example.test:18944', 'http://127.0.0.1:18944/path',
                       'http://user@127.0.0.1:18944', 'http://127.0.0.1:18944?x=1'):
            with self.subTest(origin=origin), self.assertRaises(HarnessError): self.attach(replace(self.identity, origin=origin))

    def test_process_start_marker_reads_current_exact_process(self):
        marker = operator.process_start_marker(os.getpid())
        self.assertEqual(operator.process_start_marker(os.getpid()), marker)
        self.assertTrue(marker.startswith(('windows-filetime:', 'linux-start:')))

    def test_cli_success_and_receipt_are_zero_exit_without_generating_an_identity(self):
        identity = self.root / 'operator-identity.json'; identity.write_text(json.dumps(asdict(self.identity)))
        request = self.root / 'original-operator-command.json'; request.write_text(json.dumps(self.raw))
        attached = self.attach()
        with patch.object(operator, 'attach_existing', return_value=attached), patch('sys.stdout', new_callable=io.StringIO) as output:
            code = operator.main(['--identity', str(identity), 'command', '--request', str(request)])
            value = json.loads(output.getvalue())
        self.assertEqual(code, 0); self.assertEqual(value['state'], 'paused_branch_retired')
        with patch.object(operator, 'attach_existing', return_value=attached), patch('sys.stdout', new_callable=io.StringIO) as output:
            code = operator.main(['--identity', str(identity), 'receipt', '--request-id', self.raw['request_id']])
            receipt = json.loads(output.getvalue())
        self.assertEqual(code, 0); self.assertEqual(receipt['state'], 'completed')
        self.assertEqual(receipt['result']['state'], 'paused_branch_retired')


if __name__ == '__main__': unittest.main()
