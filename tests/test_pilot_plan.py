"""Rollout consistency tests: these do not prove live dispatch or either project's acceptance."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pilot_plan', ROOT / 'scripts/validate_pilot_plan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RAW = json.loads((ROOT / 'config/pilots.json').read_text(encoding='utf-8'))


class PlanTests(unittest.TestCase):
    def bad(self, change):
        data = deepcopy(RAW)
        change(data)
        with self.assertRaises(module.PlanError):
            module.validate_plan(data)

    def test_actual_two_pilots(self):
        result = module.validate_plan(RAW)
        self.assertEqual(result['pilot_count'], 2)
        self.assertEqual(result['gate_count'], 5)

    def test_validation_is_not_live_execution(self):
        before = deepcopy(RAW)
        result = module.validate_plan(RAW)
        for k in ('runtime_queried', 'pilot_files_read', 'dispatch_performed', 'live_autonomy_verified'):
            self.assertIs(result[k], False)
        self.assertEqual(RAW, before)

    def test_math_desired_not_active(self):
        item = module.validate_plan(RAW)['pilots'][0]
        self.assertEqual(item['desired_mode'], 'goal_autopilot')
        self.assertTrue(item['handover_pending'])
        self.assertEqual(item['activation_state'], 'not_activated')

    def test_unity_does_not_wait_for_math_overnight(self):
        gates = {g['id']: g for g in RAW['gates']}
        self.assertEqual(gates['G4']['depends_on'], ['G1'])

    def test_other_domain_and_names_need_no_core_changes(self):
        data = deepcopy(RAW)
        p = data['pilots'][0]
        p.update(id='document-editing', root='D:/Work/Papers/Example', project_id='agent:any:paper')
        p['resources'] = [{'id':'review-seat','capacity':3,'available_capacity':2,'availability':'available','owner':'editor','scope':'manuscript review','requires_frozen_inputs':True,'unknown_occupancy':'retain_and_reconcile_original_execution'}]
        data['pilots'] = [p]
        self.assertEqual(module.validate_plan(data)['pilot_count'], 1)

    def test_no_resource_is_valid_for_readonly_project(self):
        data = deepcopy(RAW); data['pilots'][0]['resources'] = []
        self.assertTrue(module.validate_plan(data)['plan_consistent'])

    def test_blocked_resource_cannot_claim_availability(self):
        self.bad(lambda x: x['pilots'][0]['resources'][0].update(available_capacity=1))

    def test_duplicate_resource_rejected(self):
        self.bad(lambda x: x['pilots'][0]['resources'].append(deepcopy(x['pilots'][0]['resources'][0])))

    def test_no_domain_special_fields_in_core(self):
        self.bad(lambda x: x['pilots'][1]['resources'][0].update(unity_window=True))

    def test_lease_expiry_not_release(self):
        self.bad(lambda x: x['pilots'][1]['resources'][0].update(unknown_occupancy='release_on_timeout'))

    def test_unknown_schema(self): self.bad(lambda x: x.update(schema_version=3))
    def test_boolean_schema_rejected(self): self.bad(lambda x: x.update(schema_version=True))
    def test_no_dispatch_switch(self): self.bad(lambda x: x.update(dispatch_enabled=True))
    def test_no_credential_fields(self): self.bad(lambda x: x['pilots'][0].update(api_key='synthetic'))
    def test_no_silent_model_fallback(self): self.bad(lambda x: x['common'].update(model_fallback_allowed=True))
    def test_no_idle_restart(self): self.bad(lambda x: x['common'].update(ordinary_idle_is_failure=True))
    def test_user_stop_wins(self): self.bad(lambda x: x['common'].update(human_stop_precedes_autoresume=False))
    def test_dispatch_acceptance_not_resume(self): self.bad(lambda x: x['common'].update(host_acceptance_is_resume_proof=True))
    def test_no_clock_splitting(self): self.bad(lambda x: x['common'].update(task_time_splitting=True))
    def test_duplicate_gate(self): self.bad(lambda x: x['gates'].append(deepcopy(x['gates'][0])))
    def test_unknown_dependency(self): self.bad(lambda x: x['gates'][0].update(depends_on=['missing']))
    def test_cyclic_dependency(self): self.bad(lambda x: x['gates'][0].update(depends_on=['G3']))
    def test_no_done_without_evidence(self): self.bad(lambda x: x['gates'][0].update(status='done'))
    def test_no_done_before_dependency(self): self.bad(lambda x: x['gates'][1].update(status='done', evidence=['evidence/future.json']))
    def test_duplicate_pilot(self): self.bad(lambda x: x['pilots'].append(deepcopy(x['pilots'][0])))
    def test_casefold_same_root(self): self.bad(lambda x: x['pilots'][1].update(root=x['pilots'][0]['root'].upper()))
    def test_unknown_native_project(self): self.bad(lambda x: x['pilots'][0].update(project_id='math'))
    def test_no_root_widening_to_drive(self): self.bad(lambda x: x['pilots'][0].update(root='D:/'))
    def test_no_relative_root(self): self.bad(lambda x: x['pilots'][0].update(root='../math'))
    def test_no_source_traversal(self): self.bad(lambda x: x['pilots'][0]['sources'][0].update(path='../outside'))
    def test_no_absolute_source(self): self.bad(lambda x: x['pilots'][0]['sources'][0].update(path='C:/outside'))
    def test_bad_observed_hash(self): self.bad(lambda x: x['pilots'][0]['sources'][0].update(sha256='not-a-hash'))
    def test_no_activation_claim(self): self.bad(lambda x: x['pilots'][0].update(activation_state='active'))
    def test_handover_cannot_be_skipped(self): self.bad(lambda x: x['pilots'][0]['handover'].update(required=False))
    def test_unknown_required_gate(self): self.bad(lambda x: x['pilots'][0].update(required_gates=['missing']))
    def test_current_phase_cannot_exceed_project_compute_limit(self): self.bad(lambda x: x['pilots'][0]['resources'][0].update(available_capacity=3))
    def test_no_negative_resource_capacity(self): self.bad(lambda x: x['pilots'][1]['resources'][0].update(capacity=-1))
    def test_external_actions_not_blanket_authorized(self): self.bad(lambda x: x['pilots'][0].update(external_actions_require_separate_authorization=[]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
