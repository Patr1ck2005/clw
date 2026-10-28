"""Deadline-bound command wrappers without waiting for inherited pipe EOF.

Capture uses private delete-on-close temporary files (named on Windows), never
support logs. Only the directly created process is killed on timeout; shared
services and descendants are untouched. Returned output is byte limited.
"""
from contextlib import ExitStack
import math
import subprocess
import tempfile
import time


MAX_OUTPUT_BYTES = 1024 * 1024
REAP_TIMEOUT = .5


class BoundedResult(subprocess.CompletedProcess):
    def __init__(self, args, returncode, stdout, stderr, stdout_truncated=False,
                 stderr_truncated=False):
        super().__init__(args, returncode, stdout, stderr)
        self.stdout_truncated = stdout_truncated
        self.stderr_truncated = stderr_truncated


def _stop_wrapper(child, reap_timeout):
    # Popen retains the exact Windows process handle. No PID/tree lookup or
    # process-group termination is allowed here.
    try:
        child.kill()
    except OSError:
        pass
    try:
        child.wait(timeout=reap_timeout)
    except (OSError, subprocess.TimeoutExpired):
        pass


def run_bounded(args, *, timeout, capture_stdout=False, capture_stderr=False,
                check=False, text=True, encoding='utf-8', errors='strict',
                max_output_bytes=MAX_OUTPUT_BYTES, reap_timeout=REAP_TIMEOUT,
                **kwargs):
    """Return bounded output, or raise TimeoutExpired with no raw output.

    Process creation cannot itself be interrupted by Python. Once Popen returns,
    wait uses the remaining monotonic budget; cleanup adds at most reap_timeout.
    Temporary files close even when descendants still hold their own handles.
    In particular, do not replace this with a Popen context manager: its exit
    performs an unbounded wait.
    """
    if (not math.isfinite(timeout) or timeout <= 0
            or not math.isfinite(reap_timeout) or reap_timeout < 0
            or not isinstance(max_output_bytes, int) or max_output_bytes < 0):
        raise ValueError('invalid_bounded_process_limit')
    if any(name in kwargs for name in ('stdin', 'stdout', 'stderr')):
        raise ValueError('bounded_process_stdio_is_owned')
    started = time.monotonic()
    with ExitStack() as stack:
        stdout = stack.enter_context(tempfile.TemporaryFile(mode='w+b')) if capture_stdout else None
        stderr = stack.enter_context(tempfile.TemporaryFile(mode='w+b')) if capture_stderr else None
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL,
            stdout=stdout if stdout is not None else subprocess.DEVNULL,
            stderr=stderr if stderr is not None else subprocess.DEVNULL,
            **kwargs)
        try:
            returncode = child.wait(timeout=max(0, timeout - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            _stop_wrapper(child, reap_timeout)
            # Partial output can include keys; timeout callers only need a fixed
            # classification. Never attach it to an exception/diagnostic record.
            raise subprocess.TimeoutExpired(args, timeout) from None
        except BaseException:
            _stop_wrapper(child, reap_timeout)
            raise

        def read(stream):
            if stream is None:
                return None, False
            stream.seek(0)
            data = stream.read(max_output_bytes + 1)
            truncated = len(data) > max_output_bytes
            data = data[:max_output_bytes]
            return (data.decode(encoding, errors) if text else data), truncated

        out, out_truncated = read(stdout)
        err, err_truncated = read(stderr)
        result = BoundedResult(args, returncode, out, err, out_truncated, err_truncated)
        if check:
            result.check_returncode()
        return result
