from pathlib import Path
import sqlite3,sys,unittest
import tempfile
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_work_package import WORK_PACKAGE_GUIDANCE,work_message,goal_result_guidance

class WorkMessageTests(unittest.TestCase):
    def test_preview_does_not_send_developer_machine_or_nonexistent_rule_pointers(self):
        import harness_work_package as module
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'.local').mkdir();(root/'.local/preview-installation.json').write_text('{}')
            project=root/'user project';project.mkdir()
            with patch.object(module,'ROOT',root):
                first=work_message('Complete my work',project=project,first=True)
                self.assertNotIn('D:/Dev',first);self.assertNotIn('AGENTS.md',first)
                (project/'AGENTS.md').write_text('Project rules')
                with_rules=work_message('Complete my work',project=project,first=True)
                self.assertIn((project/'AGENTS.md').as_posix(),with_rules)
                self.assertNotIn('D:/Dev',with_rules)
                self.assertEqual(with_rules.count(WORK_PACKAGE_GUIDANCE),1)

    def test_fixed_core_once_and_initial_navigation_without_later_reread(self):
        requirement='Keep original paths, formulas \\(x^2\\), and line order.\nSecond line.'
        first=work_message(requirement,project='D:/Dev/Projects/example',first=True)
        self.assertIn(requirement,first);self.assertEqual(first.count(WORK_PACKAGE_GUIDANCE),1)
        for pointer in ['D:/Dev/README.md','D:/Dev/AGENTS.md','D:/Dev/WorkFlow/README.md','D:/Dev/Projects/example']:
            self.assertIn(pointer,first)
        resumed=work_message(requirement,project='D:/Dev/Projects/example')
        self.assertNotIn('AGENTS.md',resumed);self.assertNotIn('README.md',resumed)
        changed=work_message(requirement,pointers=('D:/Dev/Projects/example/CURRENT.md',))
        self.assertIn('CURRENT.md',changed);self.assertNotIn('D:/Dev/AGENTS.md',changed)

    def test_goal_result_protocol_only_for_enabled_current_goal(self):
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
        self.assertEqual(goal_result_guidance(db,'thread','request'),'')
        db.execute('CREATE TABLE managed_goals(thread_id TEXT,request_id TEXT,state TEXT)')
        db.execute("INSERT INTO managed_goals VALUES('thread','request','active')")
        guidance=goal_result_guidance(db,'thread','request')
        self.assertIn('CLW_GOAL_STATUS:',guidance);self.assertIn('原 Job 已提交',guidance)
        self.assertEqual(goal_result_guidance(db,'thread','other'),'')
        for state in ['paused','delivered','complete']:
            db.execute('UPDATE managed_goals SET state=?',(state,))
            self.assertEqual(goal_result_guidance(db,'thread','request'),'')

if __name__=='__main__':unittest.main()
