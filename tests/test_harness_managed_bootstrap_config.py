"""Candidate operator tested only against temporary real ledger fixtures."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
import uuid

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import test_harness_managed_handoff as fixture
import harness_managed_bootstrap_config as operator
from harness_state import HarnessError, canonical

FORMAL = {'model': 'GPT-6 · Latest', 'effort': 'Pro', 'selection': ['Latest']}
ORIGINAL = {'model': 'GPT-6 · Latest', 'effort': 'Extra High', 'selection': ['Latest']}


def choice(model, effort, position):
    return {'model': model, 'effort': effort, 'selection': ['Latest'],
            'description': ('5.6 Extra High，第 4 项，共 5 项。' if position == 3
                            else '6 Pro，第 5 项，共 5 项。') + ' 使用左右方向键调整强度',
            'sliderCount': 1, 'sliderContainerCount': 1,
            'slider': {'min': 0, 'max': 4, 'value': position},
            'efforts': [{'value': n, 'label': '', 'available': True, 'selected': n <= position} for n in range(5)],
            'options': [{'name': 'Latest', 'checked': True, 'available': True},
                        {'name': 'GPT-5.6 Sol', 'checked': False, 'available': True}]}


class BootstrapConfigTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.HandoffTests(); self.f.setUp()
        self.m = self.f.m; self.h = self.f.h; self.root = self.h.root
        self.source, _, self.offer, self.context, handoff = self.f.begin()
        with closing(self.h.state.connect()) as db:
            settings = json.loads(db.execute('SELECT settings FROM managed_pages WHERE page_id=?', (self.source,)).fetchone()[0])
            settings.update(model_selection=FORMAL, bootstrap_model_selection=FORMAL, account='A')
            db.execute('UPDATE managed_pages SET model=?,effort=?,settings=? WHERE page_id=?',
                       (FORMAL['model'], FORMAL['effort'], canonical(settings), self.source)); db.commit()
        self.page = self.f.f.private(self.source, 'handoff', handoff)['successor_page']
        self.f.finish_source(self.source, self.offer)
        self.m.browser('page-issue', {'page_id': self.page, 'kind': 'model_unavailable', 'detail': 'Original exact public model rejection.'})
        with closing(self.h.state.connect()) as db:
            operator.schema(db); db.commit()
            self.before = dict(db.execute('SELECT * FROM managed_pages WHERE page_id=?', (self.page,)).fetchone())
            expected = operator.expected_state(self.m, db, self.page)
        self.owner = {'owner_pid': os.getppid(), 'core_pid': os.getpid(), 'store_id': self.m.state.id}
        setup = choice('GPT-5.6 · Latest', 'Extra High', 3)
        at = datetime.fromtimestamp(self.h.clock(), timezone.utc).isoformat()
        self.intent = {'at': at, 'owner': self.owner['owner_pid'], 'page': self.page, 'targetId': 'real-fixture-browser-target',
                       'before': setup, 'kind': 'public_effort_inspection_and_exact_restore', 'modelSends': 0}
        self.proof = {'at': at, 'result': {'before': setup, 'pro': choice('GPT-6 · Latest', 'Pro', 4),
                                         'after': setup, 'restored': True, 'modelSends': 0}}
        self.evidence = {'intent_path': 'evidence/operator-intent.json', 'receipt_path': 'evidence/operator-receipt.json'}
        self.decision = {'state': 'approved', 'approval_ref': 'fixture explicit human answer', 'page': self.page, 'account': 'A',
                         'observedPublicChoice': 'Latest', 'observedSetup': {'model': 'GPT-5.6 · Latest', 'effort': 'Extra High'},
                         'observedFormalWork': {'model': 'GPT-6 · Latest', 'effort': 'Pro'}, 'exactOriginalEffortRestored': True,
                         'modelSends': 0, 'evidence': self.evidence['receipt_path']}
        self.payload = {'page_id': self.page, 'operation_id': str(uuid.uuid4()), 'confirm': True, 'expected': expected,
                        'owner': self.owner, 'evidence': self.evidence,
                        'live': {'page_id': self.page, 'target_id': self.intent['targetId'], 'account': 'A', 'owner': self.owner,
                                 'url': self.before['url'], 'observed_at': self.h.clock(), 'model_selection': deepcopy(setup),
                                 'generating': False, 'draft': False, 'composing': False, 'loginRequired': False,
                                 'approvalRequired': False, 'editor': True, 'controlKnown': True}}
        self.save_proofs()

    def tearDown(self): self.f.tearDown()

    def write_json(self, relative, value):
        dest = self.root / relative; dest.parent.mkdir(parents=True, exist_ok=True)
        raw = canonical(value).encode('utf-8'); dest.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def save_proofs(self):
        self.payload['decision_sha256'] = self.write_json(operator.DECISION, self.decision)
        self.evidence['intent_sha256'] = self.write_json(self.evidence['intent_path'], self.intent)
        self.evidence['receipt_sha256'] = self.write_json(self.evidence['receipt_path'], self.proof)

    def apply(self, payload=None):
        with self.h.lock, closing(self.h.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            result = operator.configure(self.m, db, self.payload if payload is None else payload)
            db.commit(); return result

    def rows(self):
        with closing(self.h.state.connect()) as db:
            return {name: [dict(row) for row in db.execute('SELECT * FROM ' + name).fetchall()] for name in
                    ('managed_pages', 'managed_page_issues', 'managed_pause_owners', 'managed_stops',
                     'managed_handoffs', 'host_requests', 'host_runs', 'control_attempts', 'operations',
                     'managed_bootstrap_budget', 'host_team_receipts', 'managed_bootstrap_config_intents')}

    def assert_rejected_unchanged(self, error, payload=None):
        before = self.rows()
        with self.assertRaisesRegex(HarnessError, error): self.apply(payload)
        self.assertEqual(self.rows(), before)

    def mutate(self, sql, args=(), refresh=False):
        with closing(self.h.state.connect()) as db:
            db.execute(sql, args); db.commit()
            if refresh: self.payload['expected'] = operator.expected_state(self.m, db, self.page)

    def test_explicit_config_only_changes_bootstrap_settings_and_writes_original_intent_receipt(self):
        before = self.rows(); result = self.apply(); after = self.rows()
        self.assertEqual(result['model_sends'], 0); self.assertFalse(result['bootstrap_model_verified'])
        old = next(row for row in before['managed_pages'] if row['page_id'] == self.page)
        new = next(row for row in after['managed_pages'] if row['page_id'] == self.page)
        self.assertEqual({k: v for k, v in old.items() if k != 'settings'}, {k: v for k, v in new.items() if k != 'settings'})
        old_settings, new_settings = json.loads(old['settings']), json.loads(new['settings'])
        changed = {k for k in set(old_settings) | set(new_settings) if old_settings.get(k) != new_settings.get(k)}
        self.assertLessEqual(changed, {'bootstrap_model_selection', 'bootstrap_model_verified', 'bootstrap_model_configuration'})
        self.assertEqual(new_settings['bootstrap_model_selection'], self.payload['live']['model_selection'])
        self.assertEqual(new_settings['model_selection'], FORMAL)
        self.assertTrue(new_settings['work_model_pending']); self.assertFalse(new_settings['bootstrap_model_verified'])
        for table in before:
            if table not in ('managed_pages', 'host_team_receipts', 'managed_bootstrap_config_intents'):
                self.assertEqual(before[table], after[table], table)
        self.assertEqual(len(after['managed_bootstrap_config_intents']), 1)
        self.assertEqual(after['managed_bootstrap_config_intents'][0]['operation_id'], self.payload['operation_id'])
        self.assertEqual(after['host_team_receipts'][-1]['operation'], operator.OPERATION)
        # Configuration is not browser verification; normal ready remains exact.
        wrong = {**self.payload['live']['model_selection'], 'model': 'GPT-7 · Latest'}
        with self.assertRaisesRegex(HarnessError, 'managed_model_observation_mismatch'):
            self.m.browser('bootstrap-model-ready', {'page_id': self.page, 'model_selection': wrong})
        verified = self.m.browser('bootstrap-model-ready', {'page_id': self.page, 'model_selection': self.payload['live']['model_selection']})
        self.assertTrue(verified['verified']); self.assertEqual(verified['model_sends'], 0)

    def test_pending_preselected_or_missing_human_decision_cannot_approve(self):
        for state in ('awaiting_user_choice', 'pending', 'default', ''):
            with self.subTest(state=state):
                self.decision['state'] = state; self.save_proofs()
                self.assert_rejected_unchanged('approval_required')
        self.decision['state'] = 'approved'; self.decision.pop('approval_ref'); self.save_proofs()
        self.assert_rejected_unchanged('human_approval_reference')

    def test_wrong_approval_page_account_or_formal_model_rejects(self):
        original = deepcopy(self.decision)
        for changed in ({'page': 'other-page'}, {'account': 'B'},
                        {'observedSetup': {'model': 'GPT-6 · Latest', 'effort': 'Extra High'}},
                        {'observedFormalWork': {'model': 'GPT-5.6 · Latest', 'effort': 'Pro'}}, {'modelSends': 1}):
            with self.subTest(changed=changed):
                self.decision = {**original, **changed}; self.save_proofs()
                self.assert_rejected_unchanged('approval_mismatch')

    def test_changed_hash_owner_and_stale_live_snapshot_reject(self):
        self.payload['decision_sha256'] = '0' * 64
        self.assert_rejected_unchanged('evidence_changed'); self.save_proofs()
        for changed, code in (({'core_pid': self.owner['core_pid'] + 1}, 'owner_changed'),
                              ({'store_id': 'different-store'}, 'owner_changed')):
            payload = deepcopy(self.payload); payload['owner'].update(changed)
            self.assert_rejected_unchanged(code, payload)
        for key, value in (('observed_at', self.h.clock() - 31), ('target_id', 'another-browser'),
                           ('account', 'B'), ('generating', True), ('draft', True), ('approvalRequired', True)):
            payload = deepcopy(self.payload); payload['live'][key] = value
            self.assert_rejected_unchanged('live_proof_changed', payload)

    def test_public_actual_shape_proof_pro_restore_and_single_visible_controls_required(self):
        original = deepcopy(self.proof)
        for section, key, value, code in (('after', 'sliderCount', 2, 'original_proof_mismatch'),
                                         ('pro', 'model', 'GPT-5.6 · Latest', 'public_choice_mismatch'),
                                         ('pro', 'description', '5.6 Pro', 'public_description_mismatch'),
                                         ('pro', 'sliderContainerCount', 2, 'public_controls_not_unique')):
            with self.subTest(section=section, key=key):
                self.proof = deepcopy(original); self.proof['result'][section] = deepcopy(self.proof['result'][section])
                self.proof['result'][section][key] = value; self.save_proofs()
                self.assert_rejected_unchanged(code)
        self.proof = original; self.proof['result']['restored'] = False; self.save_proofs()
        self.assert_rejected_unchanged('original_proof_mismatch')

    def test_compare_and_swap_rejects_selection_scope_issue_claim_budget_or_identity_change(self):
        mutations = [
            ('UPDATE managed_page_issues SET detail=? WHERE page_id=?', ('changed original issue', self.page)),
            ('UPDATE managed_pages SET root=? WHERE page_id=?', (str(self.root / 'other'), self.page)),
            ('UPDATE managed_handoffs SET successor_request=? WHERE successor_page=?', ('changed-successor', self.page)),
            ('UPDATE host_runs SET dispatches=dispatches+1 WHERE id=?', (self.context['run']['id'],)),
            ('UPDATE managed_pause_owners SET source=? WHERE page_id=?', ('operator', self.page)),
        ]
        for sql, args in mutations:
            with self.subTest(sql=sql):
                self.mutate(sql, args)
                self.assert_rejected_unchanged('state_changed')
                with closing(self.h.state.connect()) as db: self.payload['expected'] = operator.expected_state(self.m, db, self.page)

    def test_sent_unknown_thread_first_task_non_model_issue_and_non_enrolling_reject(self):
        # Each scenario gets a fresh real temporary ledger, not reset live data.
        scenarios = [('sent', "UPDATE managed_pages SET bootstrap_state='sent' WHERE page_id=?", 'unsent_paused'),
                     ('unknown', "UPDATE managed_pages SET bootstrap_state='unknown' WHERE page_id=?", 'unsent_paused'),
                     ('unpaused', 'UPDATE managed_pages SET paused=0 WHERE page_id=?', 'unsent_paused'),
                     ('other-issue', "UPDATE managed_page_issues SET kind='bootstrap_failed' WHERE page_id=?", 'issue_changed'),
                     ('not-enrolling', "UPDATE managed_handoffs SET state='prepared' WHERE successor_page=?", 'handoff_changed')]
        for index, (name, sql, code) in enumerate(scenarios):
            if index: self.tearDown(); self.setUp()
            with self.subTest(name=name):
                self.mutate(sql, (self.page,)); self.assert_rejected_unchanged(code)
        for change in ({'first_turn_mode': 'task_v1'}, {'first_turn_instructions': 'Substantive work'},
                       {'work_model_pending': False}, {'first_task_parent': {'request_id': 'first-work'}}):
            self.tearDown(); self.setUp()
            with closing(self.h.state.connect()) as db:
                settings = json.loads(self.before['settings']); settings.update(change)
                db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?', (canonical(settings), self.page)); db.commit()
            self.assert_rejected_unchanged('setup_only_required')

    def test_original_stop_and_admitted_bootstrap_cannot_be_changed(self):
        self.mutate('INSERT INTO managed_bootstrap_budget VALUES(?,?)', (self.page, self.context['run']['id']))
        self.assert_rejected_unchanged('original_send_or_stop_preserved')

    def test_idempotent_original_receipt_and_conflicting_key_reject(self):
        result = self.apply(); before = self.rows()
        # Lost return recovery reads or returns the exact original operation.
        self.payload['live']['observed_at'] -= 100  # Different payload conflicts, never blindly replays.
        self.assert_rejected_unchanged('team_operation_conflict')
        self.payload['live']['observed_at'] += 100
        self.assertEqual(self.apply(), result); self.assertEqual(self.rows(), before)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(operator.receipt(self.m, db, {'page_id': self.page, 'operation_id': self.payload['operation_id']}), result)
            absent = operator.receipt(self.m, db, {'page_id': self.page, 'operation_id': str(uuid.uuid4())})
            self.assertEqual(absent['state'], 'not_recorded'); self.assertFalse(absent['retry_authorized'])

    def test_atomic_rollback_if_durable_receipt_cannot_be_written(self):
        with closing(self.h.state.connect()) as db:
            db.execute("CREATE TRIGGER fail_config_receipt BEFORE INSERT ON host_team_receipts WHEN NEW.operation='configure-bootstrap-model' BEGIN SELECT RAISE(ABORT,'fixture receipt rejected'); END"); db.commit()
        before = self.rows()
        with self.assertRaisesRegex(Exception, 'fixture receipt rejected'): self.apply()
        self.assertEqual(self.rows(), before)

    def test_original_unknown_intent_reconciles_without_retry(self):
        with closing(self.h.state.connect()) as db:
            actor = self.h.binding(db, thread=self.payload['expected']['source_thread'])['spec']['session_id']
            db.execute('INSERT INTO managed_bootstrap_config_intents VALUES(?,?,?,?,?,?,?)',
                       (self.payload['operation_id'], self.page, actor, 'f' * 64, '{}', 'accepted', self.h.clock())); db.commit()
            value = operator.receipt(self.m, db, {'page_id': self.page, 'operation_id': self.payload['operation_id']})
        self.assertEqual(value['state'], 'unknown_reconcile_original'); self.assertFalse(value['retry_authorized'])
        self.assert_rejected_unchanged('original_operation_unknown')

    def test_helper_requires_existing_transaction_and_is_not_live_registered(self):
        with closing(self.h.state.connect()) as db:
            with self.assertRaisesRegex(HarnessError, 'transaction_required'): operator.configure(self.m, db, self.payload)
        before = self.rows()
        with self.assertRaisesRegex(ValueError, 'managed_browser_operation'): self.m.browser(operator.OPERATION, self.payload)
        self.assertEqual(self.rows(), before)


if __name__ == '__main__': unittest.main()
