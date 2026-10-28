"""Text continuation fixtures exercise the real journals, without model calls."""
from contextlib import closing
from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'tests')]
import test_harness_managed as managed_fixture
from test_harness_control_plane import PAGE
from harness_managed_prompt import enrollment_blocks
from harness_recovery import CONTINUATION_SENTENCE
from harness_work_package import WORK_PACKAGE_GUIDANCE


class TextFailureContinuationTests(unittest.TestCase):
    def setUp(self):
        self.case = managed_fixture.ManagedTests()
        self.case.setUp()
        self.h, self.m = self.case.h, self.case.m
        self.now = 1000.
        self.h.clock = lambda: self.now

    def tearDown(self):
        self.case.tearDown()

    def page(self, user='a', **fields):
        return {**PAGE, 'model_label': 'GPT-6 Astra Pro', 'effort_label': '最高',
                'user_hash': user * 64, **fields}

    def wire(self, page_id, action, **fields):
        fields.setdefault('page', self.page())
        return self.case.wire(page_id, action, **fields)

    def sent(self, page_id, offer, user='b', before='c'):
        self.now += 1
        return self.wire(page_id, 'sent', attempt_id=offer['attempt_id'],
                         page=self.page(user, generating=True), assistant_before_hash=before * 64)

    def result(self, page_id, offer, text, user='b', turn='d'):
        self.now += 1
        self.m.browser('artifact', {'page_id': page_id, 'attempt_id': offer['attempt_id'],
                                   'text': text, 'assistant_turn_hash': turn * 64})
        return self.wire(page_id, 'result', attempt_id=offer['attempt_id'],
                         page=self.page(user), assistant_turn_hash=turn * 64, text=text)

    def start(self, account='B'):
        master, binding = self.case.enroll(collaboration_protocol='text_v1', account=account)
        request = self.case.f.command(binding['thread_id'], 'message.send',
                                     {'text': 'Original full development objective.'})['request_id']
        offer = self.wire(master, 'pulse')
        grant = self.wire(master, 'dispatch', attempt_id=offer['attempt_id'])
        self.assertEqual(grant['prompt'].count(WORK_PACKAGE_GUIDANCE), 1)
        self.sent(master, offer)
        with closing(self.h.state.connect()) as db:
            claim = db.execute('SELECT claim_id FROM host_requests WHERE id=?', (request,)).fetchone()[0]
            run = self.h.team.run_for_request(db, request)
            spec = db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',
                              (binding['thread_id'],)).fetchone()[0]
        return master, binding, request, offer, claim, run['id'], spec

    def recover(self, master, binding, request, user='b'):
        failed = self.page(user, failure_kind='generation_failed', failure_hash='e' * 64)
        self.assertEqual(self.wire(master, 'pulse', page=failed)['state'],
                         'browser_result_failed_recovery_pending')
        self.case.f.command(binding['thread_id'], 'message.append', {
            'text': 'New acceptance requirement after interruption.', 'expected_request_id': request})
        self.now += 15
        offer = self.wire(master, 'pulse', page=failed)
        self.assertEqual(offer['state'], 'offer')
        self.assertTrue(offer['recovery'])
        self.assertEqual(offer['request_id'], request)
        self.assertEqual(self.wire(master, 'pulse', page=failed)['attempt_id'], offer['attempt_id'])
        grant = self.wire(master, 'dispatch', attempt_id=offer['attempt_id'], page=failed)
        self.assertTrue(grant['prompt'].startswith(CONTINUATION_SENTENCE))
        self.assertNotIn('New acceptance requirement after interruption.', grant['prompt'])
        self.assertNotIn('Original full development objective.', grant['prompt'])
        self.assertEqual(grant['prompt'].count(WORK_PACKAGE_GUIDANCE),1)
        with closing(self.h.state.connect()) as db:
            queued = db.execute('''SELECT n.text FROM managed_next_round_notes q
              JOIN host_notes n ON n.id=q.note_id WHERE q.source_request_id=?''', (request,)).fetchall()
            self.assertEqual([row['text'] for row in queued], ['New acceptance requirement after interruption.'])
            delivery = dict(db.execute('SELECT * FROM managed_text_deliveries WHERE attempt_id=?',
                                       (offer['attempt_id'],)).fetchone())
            self.assertLess(db.execute('SELECT epoch FROM control_attempts WHERE id=?',
                                       (offer['attempt_id'],)).fetchone()[0], 0)
        return offer, grant['prompt'], delivery

    def assert_completed(self, binding, request, claim, run_id, spec):
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT phase,claim_id FROM host_requests WHERE id=?',
                                        (request,)).fetchone()[:], ('completed', claim))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',
                                        (binding['thread_id'],)).fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',
                                        (binding['thread_id'],)).fetchone()[0], spec)
            self.assertEqual(db.execute('SELECT state FROM host_runs WHERE id=?',
                                        (run_id,)).fetchone()[0], 'closed')
            self.assertFalse(db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',
                                         (request,)).fetchone())

    def test_no_children_failure_short_continue_completes_with_new_note_queued(self):
        master, binding, request, initial, claim, run_id, spec = self.start()
        recovery, prompt, delivery = self.recover(master, binding, request)
        self.assertIn('@Local-MCP-B', prompt)
        self.assertEqual(delivery['run_id'], run_id)
        self.assertEqual(json.loads(delivery['event_refs']), [])
        self.sent(master, recovery, user='c')
        with closing(self.h.state.connect()) as db:
            self.assertFalse(db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',
                                         (request,)).fetchone())
        final = 'Final completed work.\n```clw-plan-v1\n' + json.dumps({
            'version': 1, 'action': 'completed', 'summary': 'Complete original work.'}) + '\n```'
        self.assertEqual(self.result(master, recovery, final, user='c', turn='f')['state'], 'completed')
        self.assert_completed(binding, request, claim, run_id, spec)

    def test_failure_continue_carries_pending_worker_results_and_acks_real_delivery(self):
        master, binding, request, initial, claim, run_id, spec = self.start(account='A')
        workers = [self.case.enroll(master)[0] for _ in range(2)]
        plan = 'Dispatch both original branches.\n```clw-plan-v1\n' + json.dumps({
            'version': 1, 'action': 'dispatch',
            'workers': [{'key': str(i), 'target': worker, 'objective': 'Verify independent branch ' + str(i)}
                        for i, worker in enumerate(workers)], 'resume': 'Integrate both verified results.'}) + '\n```'
        self.assertEqual(self.result(master, initial, plan)['state'], 'yielded')
        for i, worker in enumerate(workers):
            offer = self.wire(worker, 'pulse')
            self.wire(worker, 'dispatch', attempt_id=offer['attempt_id'])
            self.sent(worker, offer)
            self.assertEqual(self.result(worker, offer, 'Saved original worker result ' + str(i),
                                         turn='f')['state'], 'completed')
        resumed = self.wire(master, 'pulse', page=self.page('b'))
        first_delivery = self.wire(master, 'dispatch', attempt_id=resumed['attempt_id'], page=self.page('b'))
        self.assertIn('Saved original worker result 0', first_delivery['prompt'])
        self.sent(master, resumed, user='c', before='d')
        recovery, prompt, delivery = self.recover(master, binding, request, user='c')
        self.assertIn('@Local-MCP\n', prompt)
        self.assertIn('Saved original worker result 0', prompt)
        self.assertIn('Saved original worker result 1', prompt)
        self.assertNotIn('planning_note', prompt)
        self.assertNotIn('按至少半小时', prompt)
        self.assertEqual(delivery['run_id'], run_id)
        self.assertEqual(len(json.loads(delivery['event_refs'])), 2)
        self.sent(master, recovery, user='a', before='d')
        final = 'Integrated both saved results.\n```clw-plan-v1\n' + json.dumps({
            'version': 1, 'action': 'completed', 'summary': 'Integrated both results.'}) + '\n```'
        self.assertEqual(self.result(master, recovery, final, user='a', turn='e')['state'], 'completed')
        self.assert_completed(binding, request, claim, run_id, spec)
        with closing(self.h.state.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_work WHERE run_id=?',
                                        (run_id,)).fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_reads WHERE run_id=?',
                                        (run_id,)).fetchone()[0], 2)

    def test_first_task_enrollment_guidance_is_once_and_preparation_stays_preparation(self):
        for mode, instructions, expected in (('task_v1', 'Develop the complete first task.', 1),
                                              ('prepare_v1', 'Prepare a scoped plan.', 0),
                                              ('task_v1', '', 0)):
            with self.subTest(mode=mode, instructions=instructions):
                blocks = enrollment_blocks(root=str(self.case.f.root), account='B', instructions=instructions,
                                           cli='fixture-client.py', store_id='fixture-store', target='fixture-target',
                                           ticket='fixture-ticket', first_turn_mode=mode)
                prompt = '\n'.join(block['text'] for block in blocks)
                self.assertEqual(prompt.count(WORK_PACKAGE_GUIDANCE), expected)
                if instructions:
                    self.assertEqual(prompt.count(instructions), 1)


if __name__ == '__main__':
    unittest.main()
