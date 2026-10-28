from pathlib import Path
import json
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bounded_process as bounded


class BoundedProcessTests(unittest.TestCase):
    def test_capture_is_bounded_and_streams_do_not_wait_for_pipe_eof(self):
        result = bounded.run_bounded([sys.executable, '-c',
            "import sys;sys.stdout.write('a'*24);sys.stderr.write('fixed error')"],
            timeout=5, capture_stdout=True, capture_stderr=True, max_output_bytes=12)
        self.assertEqual(result.stdout, 'a' * 12)
        self.assertTrue(result.stdout_truncated)
        self.assertEqual(result.stderr, 'fixed error')
        self.assertFalse(result.stderr_truncated)

    def test_nonzero_exit_preserves_capped_classification_output(self):
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            bounded.run_bounded([sys.executable, '-c',
                "import sys;sys.stderr.write('owner changed');sys.exit(7)"],
                timeout=5, capture_stderr=True, check=True)
        self.assertEqual(caught.exception.returncode, 7)
        self.assertEqual(caught.exception.stderr, 'owner changed')

    def test_timeout_reaps_only_exact_wrapper_with_bounded_second_wait(self):
        with patch.object(bounded.subprocess, 'Popen') as popen:
            child = popen.return_value
            child.wait.side_effect = subprocess.TimeoutExpired(['private-fixture'], .01)
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                bounded.run_bounded(['private-fixture'], timeout=.01,
                    capture_stderr=True, reap_timeout=.02)
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_count, 2)
        self.assertLessEqual(child.wait.call_args_list[0].kwargs['timeout'], .01)
        self.assertEqual(child.wait.call_args_list[1].kwargs['timeout'], .02)
        child.communicate.assert_not_called()
        child.__enter__.assert_not_called()
        child.__exit__.assert_not_called()
        self.assertIsNone(caught.exception.output)
        self.assertIsNone(caught.exception.stderr)

    def test_real_descendant_keeps_stderr_alive_after_deadline_and_self_exits(self):
        # This exercises the Windows regression with real inherited handles,
        # without touching any product process. The descendant owns its timer.
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            heartbeat, done, identity = (root / name for name in ('heartbeat', 'done', 'child.json'))
            descendant = (
                "import pathlib,sys,time;"
                "heartbeat=pathlib.Path(sys.argv[1]);done=pathlib.Path(sys.argv[2]);"
                "end=time.monotonic()+4;"
                "exec('while time.monotonic()<end:\\n heartbeat.write_text(str(time.monotonic()))\\n time.sleep(.05)');"
                "done.write_text('self-exited')"
            )
            wrapper = (
                "import json,pathlib,subprocess,sys,time;"
                "child=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]],"
                "stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stderr,close_fds=False);"
                "pathlib.Path(sys.argv[4]).write_text(json.dumps({'pid':child.pid}));"
                "sys.stderr.write('private-fixture-output');sys.stderr.flush();time.sleep(10)"
            )
            started = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                bounded.run_bounded([sys.executable, '-c', wrapper, descendant,
                    str(heartbeat), str(done), str(identity)], timeout=1,
                    capture_stderr=True)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 2.5, 'waited for the four-second inherited stderr holder')
            self.assertIsNone(caught.exception.stderr)
            self.assertGreater(json.loads(identity.read_text())['pid'], 0)
            previous = heartbeat.read_text()
            limit = time.monotonic() + 1
            while heartbeat.read_text() == previous and time.monotonic() < limit:
                time.sleep(.02)
            self.assertNotEqual(heartbeat.read_text(), previous, 'descendant was killed with its wrapper')
            self.assertFalse(done.exists())
            limit = time.monotonic() + 5
            while not done.exists() and time.monotonic() < limit:
                time.sleep(.02)
            self.assertEqual(done.read_text(), 'self-exited')


if __name__ == '__main__':
    unittest.main()
