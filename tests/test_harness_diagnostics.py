import json
import hashlib
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import harness_diagnostics as diagnostics


class DiagnosticCases(unittest.TestCase):
    def test_summary_separates_delivery_reports_and_partial_artifacts(self):
        cases = [
            {'case_id': 'ok', 'case_sends_confirmed': 1, 'artifact_and_protocol_complete': True},
            {'case_id': 'partial', 'case_sends_confirmed': 1, 'artifact_and_protocol_complete': True,
             'outcome': 'reported_refusal_stop'},
            {'case_id': 'setup', 'case_sends_confirmed': 0, 'outcome': 'setup_reported_scope_denial'},
            {'case_id': 'unknown', 'case_sends_confirmed': None},
            {'case_id': 'transport', 'case_sends_confirmed': 1, 'outcome': 'needs_attention'},
        ]
        result = diagnostics.summarize_cases({'cases': cases})
        counts = result['counts']
        self.assertEqual(counts['sent_cases'], 3)
        self.assertEqual(counts['complete_cases'], 1)
        self.assertEqual(counts['reported_refusal_cases'], 1)
        self.assertEqual(counts['other_or_unresolved_sent_cases'], 1)
        self.assertEqual(counts['unknown_delivery_cases'], 1)
        self.assertEqual(counts['confirmed_not_sent_cases'], 1)
        self.assertAlmostEqual(counts['historical_report_fraction'], 1 / 3)
        self.assertIsNone(result['current_failure_probability'])
        self.assertIsNone(result['per_tool_refusal_probability'])
        self.assertIsNone(result['platform_confirmed_refusal_rate'])

    def test_summary_does_not_inflate_samples_with_repeated_sends(self):
        cases = [{'case_id': 'one', 'case_sends_confirmed': 3, 'route': 'web'},
                 {'case_id': 'two', 'case_sends_confirmed': 1, 'route': 'native',
                  'reported_platform_refusal': True}]
        result = diagnostics.summarize_cases({'cases': cases})
        self.assertEqual(result['counts']['confirmed_sends'], 4)
        self.assertEqual(result['counts']['sent_cases'], 2)
        self.assertEqual(result['counts']['historical_report_fraction'], .5)
        self.assertEqual(result['groups_descriptive_only']['route']['native']['reported_refusal_cases'], 1)
        with self.assertRaisesRegex(ValueError, 'duplicate_case_id'):
            diagnostics.summarize_cases({'cases': cases + [cases[0]]})

    def test_summary_missing_denominator_is_not_zero_risk(self):
        result = diagnostics.summarize_cases({'cases': [{'case_id': 'unknown'}]})
        self.assertIsNone(result['counts']['historical_report_fraction'])
        self.assertFalse(result['randomness_established'])
        for invalid in (True, -1, '1', 1.5):
            with self.assertRaisesRegex(ValueError, 'invalid_confirmed_send_count'):
                diagnostics.summarize_cases({'cases': [{'case_id': 'bad', 'case_sends_confirmed': invalid}]})

    def test_append_only_workspace_changes_retain_earlier_case_paths(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'experiment'
            diagnostics.prepare(root)
            cases = diagnostics.read(root / 'manifest.json')['cases']
            digest = hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()
            original = cases[7]['workspace']
            diagnostics.save(root / 'workspace-amendment.json', {
                'manifest_sha256': digest, 'reason': 'initial path isolation',
                'workspaces': {cases[3]['id']: str(root/'denied'), cases[7]['id']: str(root/'unstarted')}})
            diagnostics.save(root / 'workspace-amendment-02.json', {
                'manifest_sha256': digest, 'reason': 'future cases use the authorized root',
                'workspaces': {cases[7]['id']: original},
                'prompt_files': {cases[7]['id']: cases[7]['id'] + '.prompt.md'}})
            self.assertEqual(diagnostics.case_for(root, cases[3]['id'])['workspace'], str(root/'denied'))
            current = diagnostics.case_for(root, cases[7]['id'])
            self.assertEqual(current['workspace'], original)
            self.assertEqual(len(current['amendment_history']), 2)
            manifest = diagnostics.read(root/'manifest.json')
            manifest['planned_cases'] = 25
            diagnostics.save(root/'manifest.json', manifest)
            with self.assertRaisesRegex(ValueError, 'original_manifest_changed'):
                diagnostics.case_for(root, cases[7]['id'])

    def test_predeclared_balanced_cases_and_immutable_attempt_link(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'experiment'
            self.assertEqual(diagnostics.prepare(root)['cases'], 24)
            cases = diagnostics.read(root / 'manifest.json')['cases']
            combinations = {}
            for case in cases:
                key = (case['route'], case['wording'], case['organization'])
                combinations[key] = combinations.get(key, 0) + 1
                self.assertFalse((Path(case['workspace']) / 'manifest.json').exists())
            self.assertEqual(len(combinations), 8)
            self.assertEqual(set(combinations.values()), {3})
            with self.assertRaisesRegex(ValueError, 'do_not_overwrite'):
                diagnostics.prepare(root)
            evidence = root / 'link.json'
            diagnostics.save(evidence, {'source': 'original_receipt', 'request_id': 'r1'})
            diagnostics.link(root, cases[0]['id'], evidence)
            with self.assertRaises(FileExistsError):
                diagnostics.link(root, cases[0]['id'], evidence)
            with self.assertRaisesRegex(ValueError, 'case_not_predeclared'):
                diagnostics.link(root, '../not-a-case', evidence)

    def test_correct_files_never_claim_execution_or_safety_acceptance(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'experiment'
            diagnostics.prepare(root)
            case = diagnostics.read(root / 'manifest.json')['cases'][0]
            workspace = Path(case['workspace'])
            diagnostics.save(workspace / 'result.json', case['expected'])
            (workspace / 'RESULT.md').write_text('[机器结果](result.json)', encoding='utf-8')
            report = diagnostics.verify(root, case['id'])
            self.assertTrue(report['arithmetic_matches'])
            self.assertTrue(report['input_matches'])
            self.assertEqual(report['platform_refusal_cause'], 'unknown')
            self.assertEqual(report['execution_success'], 'requires_original_tool_receipts_and_readback')
            (workspace / 'unrequested.txt').write_text('extra side effect', encoding='utf-8')
            self.assertEqual(diagnostics.verify(root, case['id'])['unexpected_workspace_files'],['unrequested.txt'])
            (workspace / 'input-1.json').write_text('{}', encoding='utf-8')
            self.assertFalse(diagnostics.verify(root, case['id'])['input_matches'])


if __name__ == '__main__':
    unittest.main()
