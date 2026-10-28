"""WB002.3 full regression in isolated stores/browsers; preserve every attempt and source hash."""
from pathlib import Path
from datetime import datetime,timezone
import subprocess,sys,os,json,hashlib,re,shutil
ROOT=Path(__file__).resolve().parents[1]
def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    run=ROOT/'evidence/WB002-3/runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
    env=os.environ.copy();env['PYTHONUTF8']='1';env['CLW_TASK_EVIDENCE_DIR']=str(run/'screenshots')
    # Legacy suites require their evidence prefix; keep their new screenshots isolated too.
    env['CLW_TEST_EVIDENCE_DIR']=str(ROOT/'evidence/WB002-2/runs'/('wb0023-'+run.name)/'screenshots')
    env.pop('CLW_WEBCODEX_TOKEN',None)
    files=[p for folder in ('apps/control-center','scripts','tests') for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    tasks=[('node-snapshot',[shutil.which('node'),'--test','--test-reporter=tap','tests/control-center.test.mjs']),
      ('node-live',[shutil.which('node'),'--test','--test-reporter=tap','tests/live.test.mjs']),
      ('node-tasks',[shutil.which('node'),'--test','--test-reporter=tap','tests/task-client.test.mjs'])]
    tasks += [(name,[sys.executable,'-B',path]) for name,path in [('python-snapshot','tests/test_control_center.py'),('python-adapter','tests/test_live_observer.py'),('python-link','tests/test_workbench_link.py'),('python-live-browser','tests/test_live_browser.py'),('python-tasks','tests/test_task_store.py'),('python-task-http','tests/test_task_http.py'),('python-task-browser','tests/test_task_browser.py')]]
    checks=[]
    for name,args in tasks:
        try:
            p=subprocess.run(args,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=240);output=p.stdout+p.stderr;code=p.returncode
        except subprocess.TimeoutExpired:
            output='Test process timed out; no success claimed.';code=-1
        count=re.search(r'# tests (\d+)',output) if name.startswith('node') else re.search(r'Ran (\d+) tests?',output)
        log=run/(name+'.log');log.write_text(output,encoding='utf-8')
        checks.append({'name':name,'exit_code':code,'tests':int(count.group(1)) if count else None,'log':log.relative_to(ROOT).as_posix()})
        print(name,code,'tests',checks[-1]['tests'],flush=True);print(output[-3000:],flush=True)
    unchanged=all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=unchanged and all(c['exit_code']==0 and c['tests'] for c in checks)
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'checks':checks,'total_tests':sum(c['tests'] or 0 for c in checks),'source_hashes':hashes,'sources_unchanged':unchanged,'status':'passed' if passed else 'failed','scope':'isolated local product DB, synthetic upstream, real isolated Edge','stable_backend_modified':False,'paid_model_calls':0}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'evidence/WB002-3/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('WB0023_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],flush=True)
    return 0 if passed else 1
if __name__=='__main__':raise SystemExit(main())
