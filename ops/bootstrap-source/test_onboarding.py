"""Static onboarding tests; never execute an installer or contact a service."""
from pathlib import Path
import importlib.util
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('render_guide',ROOT/'scripts/render_guide.py')
guide=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guide)

class OnboardingTests(unittest.TestCase):
    def test_manual_is_escaped_not_executed(self):
        page=guide.build_page('<script>alert("x")</script>')
        self.assertNotIn('<script>',page)
        self.assertIn('&lt;script&gt;',page)
        self.assertNotIn('<form',page)

    def test_regular_desktop_is_first_path(self):
        page=guide.build_page('Test only')
        self.assertIn('Local Full Runtime',page)
        self.assertIn(guide.INSTALLER,page)
        self.assertIn('未数字签名',page)
        self.assertIn('不按时长',page)
        self.assertNotIn('WebCodex-Code',page)
        self.assertNotIn('WebCodex-Math',page)

    def test_render_writes_page_only_and_never_launches(self):
        with tempfile.TemporaryDirectory() as d, patch('subprocess.Popen') as launch:
            root=Path(d)
            (root/'DESKTOP_FIRST_RUN.md').write_text('中文说明',encoding='utf-8')
            (root/'START.cmd').write_bytes(b'keep existing launcher')
            (root/'profiles').mkdir()
            (root/'profiles'/'sentinel.txt').write_bytes(b'untouched')
            guide.render(root)
            self.assertEqual((root/'START.cmd').read_bytes(),b'keep existing launcher')
            self.assertEqual((root/'profiles'/'sentinel.txt').read_bytes(),b'untouched')
            self.assertEqual({p.name for p in root.iterdir()}, {'DESKTOP_FIRST_RUN.md','START.cmd','profiles','START_HERE.html'})
            launch.assert_not_called()

    def test_render_has_no_silent_authorization_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with self.assertRaises(FileNotFoundError):
                guide.render(root)
            self.assertEqual(list(root.iterdir()),[])

if __name__=='__main__':
    unittest.main()
