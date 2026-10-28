"""Real Python subprocess/kernel-lock interleavings; no Electron or network."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
WORKER=r'''
import os,sys,time,json
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import web_host_launcher as launcher
from product_runtime import ProductError
root=Path(sys.argv[2]).resolve();mode=sys.argv[3];stage=sys.argv[4]
def barrier():
    (root/'ready').write_text(stage)
    deadline=time.monotonic()+8
    while not (root/'release').exists():
        if time.monotonic()>deadline:raise RuntimeError('test_barrier_timeout')
        time.sleep(.02)
def prepare(*args):
    with (root/'effects').open('a') as stream:stream.write('prepare\n')
    if stage=='prepare':barrier()
def watcher(*args):
    with (root/'effects').open('a') as stream:stream.write('watcher\n')
class Child:
    def __init__(self,index):self.pid=12000+index;self.index=index
    def wait(self):return 1 if stage=='backoff' and self.index==0 else 0
spawned=[]
def spawn(args,**kwargs):
    if kwargs.get('close_fds') is not True:raise RuntimeError('inherited_lock_handle')
    with (root/'effects').open('a') as stream:stream.write('spawn\n')
    child=Child(len(spawned));spawned.append(child);return child
def sleep(seconds):
    if stage=='backoff':barrier()
with patch.object(launcher,'existing_browser',return_value=None),patch.object(launcher,'native_identity',side_effect=lambda pid,name=None:{'pid':pid,'creationFiletime':str(100000+pid)}),patch.object(launcher,'prepare_shared_entry_bounded',side_effect=prepare),patch('harness_goal_watch.start_if_enabled',side_effect=watcher):
    try:result={'code':launcher.supervise(root,spawn,sleep)}
    except ProductError as error:result={'error':str(error)}
print(json.dumps(result))
'''

class ConcurrentLauncherTests(unittest.TestCase):
    def interleave(self,stage):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);exe=root/'apps/web-host/node_modules/electron/dist/electron.exe';exe.parent.mkdir(parents=True);exe.touch()
            folder=root/'.local/web-host';folder.mkdir(parents=True)
            original=b'{"pid":999,"state":"stopped"}';(folder/'supervisor.json').write_bytes(original)
            args=[sys.executable,'-B','-c',WORKER,str(ROOT/'scripts'),str(root),'first',stage]
            kwargs={'stdout':subprocess.PIPE,'stderr':subprocess.PIPE,'stdin':subprocess.DEVNULL,'text':True,'close_fds':True,
                    'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)}
            first=subprocess.Popen(args,**kwargs)
            try:
                deadline=time.monotonic()+5
                while not (root/'ready').exists():
                    if first.poll() is not None or time.monotonic()>deadline:self.fail('first launcher failed to reach barrier')
                    time.sleep(.02)
                before=(folder/'supervisor.json').read_bytes();effects=(root/'effects').read_bytes()
                second_args=[*args[:5],str(root/'unused/..'),'second',stage]
                second=subprocess.run(second_args,timeout=5,**kwargs)
                self.assertEqual(second.returncode,0,second.stderr)
                self.assertEqual(json.loads(second.stdout),{'error':'web_workspace_original_owner_unverified'})
                self.assertEqual((folder/'supervisor.json').read_bytes(),before)
                self.assertEqual((root/'effects').read_bytes(),effects)
                (root/'release').touch();stdout,stderr=first.communicate(timeout=5)
                self.assertEqual(first.returncode,0,stderr);self.assertEqual(json.loads(stdout),{'code':0})
                state=json.loads((folder/'supervisor.json').read_text())
                self.assertEqual(state['state'],'stopped');self.assertRegex(state['owner_epoch'],r'^[a-f0-9]{32}$')
                self.assertEqual(state['canonical_profile'],str(folder.resolve()))
                lines=(root/'effects').read_text().splitlines()
                self.assertEqual(lines.count('prepare'),1)
                expected=2 if stage=='backoff' else 1
                self.assertEqual(lines.count('spawn'),expected);self.assertEqual(lines.count('watcher'),expected)
                if stage=='prepare':self.assertEqual(before,original)
                sys.path.insert(0,str(ROOT/'scripts'));from product_runtime import FileLease
                with FileLease(folder/'supervisor.lock') as lease:self.assertFalse(os.get_inheritable(lease.file.fileno()))
            finally:
                (root/'release').touch()
                if first.poll() is None:
                    first.kill();first.communicate(timeout=2) # Only this isolated Python worker.

    def test_two_processes_share_one_canonical_profile_before_shared_prepare(self):self.interleave('prepare')
    def test_kernel_lock_is_retained_across_original_child_crash_backoff(self):self.interleave('backoff')

if __name__=='__main__':unittest.main()
