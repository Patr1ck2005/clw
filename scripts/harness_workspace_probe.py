"""Bounded read-only check of one explicitly supplied workspace, not discovery.

Does not add/check out/merge worktrees, run hooks, or alter Git configuration.
Creation and native Project registration stay with authorized Runtime tools.
"""
from pathlib import Path
import os,re,subprocess
from harness_state import require,HarnessError

def inspect_git(root):
    root=Path(root).resolve()
    env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0',GIT_TERMINAL_PROMPT='0')
    def run(*args):
        try:r=subprocess.run(['git','-C',str(root),'rev-parse',*args],capture_output=True,text=True,encoding='utf-8',errors='strict',timeout=8,env=env)
        except (OSError,subprocess.SubprocessError,UnicodeError):raise HarnessError('team_git_probe_unavailable',409) from None
        require(r.returncode==0 and len(r.stdout.encode())<=8192,'team_git_worktree_required',409)
        return r.stdout.strip()
    top=Path(run('--show-toplevel')).resolve()
    require(os.path.normcase(str(root))==os.path.normcase(str(top)),'team_exact_git_worktree_root_required',409)
    head=run('HEAD');require(re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}',head),'team_git_head_invalid',409)
    common=Path(run('--git-common-dir'))
    if not common.is_absolute():common=root/common
    return {'root':str(top),'head':head,'common_dir':str(common.resolve()),'read_only':True}
