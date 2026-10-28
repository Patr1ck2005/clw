"""The public plan is data; only a valid bound-controller result may use it."""
from pathlib import Path
import json, sys, unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from harness_state import HarnessError
from harness_managed_protocol import parse_controller_reply


class TextPlanTests(unittest.TestCase):
    def test_minimal_dispatch_needs_no_model_wait_or_resume_command(self):
        raw='```clw-plan-v1\n'+json.dumps({'version':1,'action':'dispatch','workers':[
            {'key':'A','target':'web-existing-a','objective':'完整工作包 A'},
            {'key':'B','objective':'完整工作包 B'}]},ensure_ascii=False)+'\n```'
        plan=parse_controller_reply(raw)
        self.assertEqual(plan['wait'],{'mode':'all','workers':['A','B']})
        self.assertIn('完整结果',plan['resume'])
        self.assertEqual(plan['workers'][0]['target'],'web-existing-a')

    def test_complete_dispatch_plan_keeps_worker_identity_and_full_objectives(self):
        raw = '''完整解释与公式 \\(x^2+y^2\\)。
```clw-plan-v1
{"version":1,"action":"dispatch","workers":[{"key":"A","target":"web-aaa","objective":"推导含 LaTeX 的结果"},{"key":"B","target":"web-bbb","objective":"读代码并验证","effort":"极高"}],"wait":{"mode":"all","workers":["A","B"]},"resume":"合并两个原始成果"}
```'''
        parsed = parse_controller_reply(raw)
        self.assertEqual([w['key'] for w in parsed['workers']], ['A', 'B'])
        self.assertEqual(parsed['workers'][0]['objective'], '推导含 LaTeX 的结果')
        self.assertEqual(parsed['resume'], '合并两个原始成果')

    def test_reported_rejection_does_not_override_actual_controller_decision(self):
        for action in ('completed','dispatch','needs_attention'):
            plan={'version':1,'action':action}
            if action=='dispatch':plan['workers']=[{'key':'A','objective':'原范围内独立核验'}]
            elif action=='completed':plan['summary']='调用已修正，结果已读回'
            else:plan['reason']='实际缺少权限，需要用户处理'
            for report in (
                '之前一项调用报告：This tool call was blocked by OpenAI because we could not determine the safety status of the request. 已修正参数，后续工作继续。',
                '本轮未遇到平台安全检查拦截。',
                '> 历史记录：因 OpenAI 无法确定请求的安全状态。',
            ):
                raw=report+'\n```clw-plan-v1\n'+json.dumps(plan,ensure_ascii=False)+'\n```'
                with self.subTest(action=action,report=report):
                    self.assertEqual(parse_controller_reply(raw)['action'],action)

    def test_ambiguous_or_invalid_instruction_cannot_dispatch(self):
        accepted = '''结果
~~~clw-plan-v1
{"version":1,"action":"completed","summary":"研究已结束"}
~~~'''
        self.assertEqual(parse_controller_reply(accepted)['action'], 'completed')
        cases = [
            accepted + '\n```clw-plan-v1\n{}\n```',
            '```clw-plan-v1\n{"version":1,"version":1,"action":"completed","summary":"错误"}\n```',
            '```clw-plan-v1\n{"version":1,"action":"dispatch","workers":[{"key":"A","target":"web-aaa","objective":"任务"}],"wait":{"mode":"all","workers":[{}]},"resume":"收尾"}\n```',
            '```clw-plan-v1\n{"version":1,"action":"completed","summary":"已完成","shell":"del"}\n```',
        ]
        for raw in cases:
            with self.subTest(raw=raw[:80]), self.assertRaises(HarnessError):
                parse_controller_reply(raw)

    def test_invalid_plan_aliases_and_ungranted_scope_fields_are_rejected(self):
        worker = {'key':'A','objective':'独立核验'}
        plan = {'version':1,'action':'dispatch','workers':[worker],
                'wait':{'mode':'all','workers':['A']},'resume':'核对结果'}
        cases = {
            'missing_version':{k:v for k,v in plan.items() if k!='version'},
            'access_alias':{**plan,'workers':[{**worker,'access':'read_only'}]},
            'wait_alias':{**plan,'wait':{'mode':'all','worker_keys':['A']}},
            'filename_as_resource':{**plan,'workers':[{**worker,'resources':['result.md']}]},
            'read_with_write_paths':{**plan,'workers':[{**worker,'write_paths':['src']}]},
            'existing_target_cannot_gain_write':{**plan,'workers':[
                {**worker,'target':'web-existing','access':'write','write_paths':['src']}]},
        }
        for name, invalid in cases.items():
            raw='```clw-plan-v1\n'+json.dumps(invalid,ensure_ascii=False)+'\n```'
            with self.subTest(name=name), self.assertRaises(HarnessError):
                parse_controller_reply(raw)


if __name__ == '__main__': unittest.main()
