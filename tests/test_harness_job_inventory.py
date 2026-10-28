"""Session activity stays bounded as history grows; no live Runner or model."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from harness_job_inventory import (JobInventoryError, read_session_inventory,
                                   inventory_idle, inventory_in_progress, job_terminal,
                                   ACTIVE, TERMINAL, UNCERTAIN)
from native_work_terminal import _workflow_jobs
from native_work_admission import AdmissionError
from harness_managed_attention_recovery import _proof


def reply(rows, total=None):
    total = len(rows) if total is None else total
    return {'structuredContent': {'success': True, 'error': None, 'output': {
        'jobs': rows, 'count': len(rows), 'matched_count': total,
        'truncated': total != len(rows)}}}


def job(n=0, status='completed', execution='completed', session='wc_sess_test'):
    return {'id': str(n), 'job_id': str(n), 'session_id': session,
            'status': status, 'command_execution_state': execution}


class InventoryTests(unittest.TestCase):
    def reader(self, total, active=None):
        active = active or []
        calls = []
        def read(root, name, args):
            calls.append((name, args))
            if name == 'observe_jobs':
                return {'structuredContent': {'success': True, 'error': None, 'output': {
                    'items': [{'index': i, 'job_id': x['job_id'], 'success': True,
                               'output': {**job(x['job_id']), 'terminal': True}}
                              for i, x in enumerate(args['items'])]}}}
            self.assertEqual(args['session_id'], 'wc_sess_test')
            if args.get('status'):
                rows = [j for j in active if j['status'] == args['status']]
                return reply(rows[:100], len(rows))
            rows = [job(n) for n in range(min(total, 100))]
            return reply(rows, total)
        return read, calls

    def test_100_101_and_1000_terminal_jobs_are_idle_without_unbounded_reads(self):
        for count in (100, 101, 1000):
            with self.subTest(count=count):
                read, calls = self.reader(count)
                result = read_session_inventory(Path('.'), 'wc_sess_test', read)
                self.assertTrue(inventory_idle(result, 'wc_sess_test'))
                self.assertTrue(inventory_idle(_proof(result), 'wc_sess_test'))
                self.assertEqual(len(calls), 1 if count == 100 else 1+len(ACTIVE)+len(UNCERTAIN))
                self.assertTrue(all(c[1]['limit'] == 100 for c in calls))

    def test_current_jobs_are_waiting_even_if_active_list_is_capped(self):
        for state in ACTIVE:
            for count in (1, 101):
                with self.subTest(state=state,count=count):
                    read, _ = self.reader(1000, [job(n, state, None) for n in range(count)])
                    result = read_session_inventory(Path('.'), 'wc_sess_test', read)
                    self.assertTrue(inventory_in_progress(result, 'wc_sess_test'))
                    self.assertFalse(inventory_idle(result, 'wc_sess_test'))

    def test_terminal_status_and_execution_follow_the_canonical_runner_matrix(self):
        valid={'completed':{'completed'},'failed':{'completed','not_started'},
               'stopped':{'completed','not_started'},'cancelled':{'completed','not_started'},
               'timeout':{'timed_out'},'timed_out':{'timed_out'},'lost':{'not_started'}}
        for state in ACTIVE+TERMINAL:
            for execution in ('completed','not_started','timed_out','outcome_unknown',None):
                with self.subTest(state=state,execution=execution):
                    row=job(status=state,execution=execution)
                    expected=execution in valid.get(state,set())
                    self.assertEqual(job_terminal(row),expected)
                    self.assertEqual(inventory_idle(reply([row]),'wc_sess_test'),expected)
        self.assertFalse(job_terminal({**job(status='lost',execution='not_started'),'started_at':1}))

    def test_short_stopped_completed_is_idle_but_completed_not_started_is_unknown(self):
        stopped=reply([job(status='stopped')])
        self.assertTrue(inventory_idle(read_session_inventory(Path('.'),'wc_sess_test',lambda *args:stopped),'wc_sess_test'))
        self.assertFalse(inventory_idle(reply([job(execution='not_started')]),'wc_sess_test'))

    def test_capped_sample_cannot_hide_failed_or_lost_unknown_outcome(self):
        for state in UNCERTAIN:
            with self.subTest(state=state):
                read,calls=self.reader(1000,[job('old-original-command',state,'outcome_unknown')])
                result=read_session_inventory(Path('.'),'wc_sess_test',read)
                self.assertFalse(inventory_idle(result,'wc_sess_test'))
                self.assertFalse(inventory_in_progress(result,'wc_sess_test'))
                self.assertFalse(inventory_idle(_proof(result),'wc_sess_test'))
                self.assertIn(('list_jobs',{'session_id':'wc_sess_test','status':state,'limit':100}),calls)

    def test_known_terminal_outcomes_do_not_turn_capped_completed_history_unknown(self):
        for row in (job(status='failed'),job(status='lost',execution='not_started')):
            with self.subTest(state=row['status']):
                read,_=self.reader(1000,[row]);result=read_session_inventory(Path('.'),'wc_sess_test',read)
                self.assertTrue(inventory_idle(result,'wc_sess_test'))
                self.assertTrue(inventory_idle(_proof(result),'wc_sess_test'))
        # More than 100 lost records cannot prove the unseen execution outcomes.
        read,_=self.reader(1000,[job(n,'lost','not_started') for n in range(101)])
        self.assertFalse(inventory_idle(read_session_inventory(Path('.'),'wc_sess_test',read),'wc_sess_test'))

    def test_foreign_active_scope_and_unknown_visible_execution_remain_unknown(self):
        for bad in (job(session='foreign'), job(execution='unknown')):
            def read(root, name, args):
                return reply([bad] + [job(n) for n in range(99)], 1000)
            with self.assertRaises(JobInventoryError):
                read_session_inventory(Path('.'), 'wc_sess_test', read)

    def test_cancelled_not_started_is_idle_unknown_cancel_is_not(self):
        self.assertTrue(inventory_idle(reply([job(status='cancelled', execution='not_started')]), 'wc_sess_test'))
        self.assertFalse(inventory_idle(reply([job(status='cancelled', execution='unknown')]), 'wc_sess_test'))

    def test_active_proof_cannot_hide_or_omit_one_status_query(self):
        read, _ = self.reader(101)
        value = read_session_inventory(Path('.'), 'wc_sess_test', read)
        for kind in ('missing', 'missing_uncertain', 'foreign', 'boolean_count', 'unlisted_active', 'unlisted_uncertain'):
            changed = copy.deepcopy(value); out = changed['structuredContent']['output']
            if kind == 'missing': out['active_queries'].pop()
            if kind == 'missing_uncertain': out['uncertain_queries'].pop()
            if kind == 'foreign': out['session_id'] = 'foreign'
            if kind == 'boolean_count': out['count'] = False
            if kind == 'unlisted_active': out['active_queries'][ACTIVE.index('running')]['output'] = reply([job(status='running')])['structuredContent']['output']
            if kind == 'unlisted_uncertain': out['uncertain_queries'][UNCERTAIN.index('lost')]['output'] = reply([job(status='lost',execution='outcome_unknown')])['structuredContent']['output']
            self.assertFalse(inventory_idle(changed, 'wc_sess_test'), kind)

    def test_native_checks_identified_original_job_even_when_not_in_history_sample(self):
        read, calls = self.reader(1000)
        self.assertEqual(_workflow_jobs(Path('.'), {'wc_sess_test'}, {'original-job'}, read), 1)
        self.assertEqual(calls[-1], ('observe_jobs', {'items': [{'job_id': 'original-job'}], 'tail_lines': 1}))

    def test_native_keeps_original_claim_when_session_has_live_job(self):
        read, _ = self.reader(1000, [job(status='queued', execution='not_started')])
        with self.assertRaises(AdmissionError):
            _workflow_jobs(Path('.'), {'wc_sess_test'}, {'original-job'}, read)


if __name__ == '__main__':
    unittest.main()
