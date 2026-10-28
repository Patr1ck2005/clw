"""Retained WB002.2 regressions, including snapshot compatibility. No user backend credentials."""
from pathlib import Path
from datetime import datetime,timezone
import subprocess,sys,os,json,hashlib,re,shutil
ROOT=Path(__file__).resolve().parents[1]
def main():
 sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8');os.environ['PYTHONUTF8']='1'
 run=ROOT/'evidence/WB002-2/runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
 env=os.environ.copy();env['CLW_TEST_EVIDENCE_DIR']=str(run/'screenshots')
 # Contract fixtures/tests explicitly construct their own observer; do not read credentials.
 env.pop('CLW_WEBCODEX_TOKEN',None)
 files=[p for folder in ('apps/control-center','scripts','tests') for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
 hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
 checks=[]
 tasks=[('node-snapshot',[shutil.which('node'),'--test','--test-reporter=tap','tests/control-center.test.mjs']),
        ('node-live',[shutil.which('node'),'--test','--test-reporter=tap','tests/live.test.mjs']),
        ('python-snapshot',[sys.executable,'-B','tests/test_control_center.py']),
        ('python-adapter',[sys.executable,'-B','tests/test_live_observer.py']),
        ('python-link',[sys.executable,'-B','tests/test_workbench_link.py']),
        ('python-live-browser',[sys.executable,'-B','tests/test_live_browser.py'])]
 for name,args in tasks:
  try:
   p=subprocess.run(args,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=240)
   output=p.stdout+p.stderr;code=p.returncode
  except subprocess.TimeoutExpired as exc:
   output='Timeout: no success claimed.\n'+str(exc.stdout or '')[-4000:]+str(exc.stderr or '')[-4000:];code=-1
  count=re.search(r'# tests (\d+)',output) if name.startswith('node') else re.search(r'Ran (\d+) tests?',output)
  log=run/(name+'.log');log.write_text(output,encoding='utf-8')
  checks.append({'name':name,'exit_code':code,'tests':int(count.group(1)) if count else None,'log':log.relative_to(ROOT).as_posix()})
  print(name,code,'tests',checks[-1]['tests'],flush=True);print(output[-5000:],flush=True)
 unchanged=all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
 passed=unchanged and all(x['exit_code']==0 and x['tests'] for x in checks)
 report={'recorded_at':datetime.now(timezone.utc).isoformat(),'checks':checks,'total_tests':sum(x['tests'] or 0 for x in checks),
         'source_hashes':hashes,'sources_unchanged':unchanged,'status':'passed' if passed else 'failed',
         'backend':'isolated synthetic HTTP fixtures; not stable user runtime acceptance','browser':'isolated Edge contexts',
         'stable_backend_modified':False,'paid_model_calls':0}
 (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 (ROOT/'evidence/WB002-2/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
 print('VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],flush=True)
 return 0 if passed else 1
if __name__=='__main__':raise SystemExit(main())
