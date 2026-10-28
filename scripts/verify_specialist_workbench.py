"""Full WB002.4 regression. Only isolated local stores and no-model HTTP fixtures."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,os,re,shutil,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-4/runs'/stamp;run.mkdir(parents=True)
    env=os.environ.copy();env['PYTHONUTF8']='1';env.pop('CLW_WEBCODEX_TOKEN',None)
    env['CLW_TEST_EVIDENCE_DIR']=str(ROOT/'evidence/WB002-2/runs'/('wb0024-'+stamp)/'screenshots')
    env['CLW_TASK_EVIDENCE_DIR']=str(ROOT/'evidence/WB002-3/runs'/('wb0024-'+stamp)/'screenshots')
    env['CLW_SPECIALIST_EVIDENCE_DIR']=str(run/'screenshots')
    files=[p for directory in ('apps/control-center','scripts','tests') for p in (ROOT/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    suites=[('node-'+n,[shutil.which('node'),'--test','--test-reporter=tap','tests/'+n+'.test.mjs']) for n in ('control-center','live','task-client','journal-client')]
    suites += [(n,[sys.executable,'-B','tests/test_'+n+'.py']) for n in ('control_center','live_observer','workbench_link','live_browser','task_store','task_http','task_browser','specialists','usage_store','specialist_http','specialist_browser')]
    results=[]
    for name,cmd in suites:
        try:
            p=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=300);code=p.returncode;output=p.stdout+p.stderr
        except subprocess.TimeoutExpired:code=-1;output='Test deadline exceeded; no success claimed.'
        count=re.search(r'# tests (\d+)',output) if name.startswith('node-') else re.search(r'Ran (\d+) tests?',output)
        tests=int(count.group(1)) if count else None
        (run/(name+'.log')).write_text(output,encoding='utf-8');results.append({'name':name,'exit_code':code,'tests':tests,'log':(run/(name+'.log')).relative_to(ROOT).as_posix()})
        print(name,code,'tests',tests,flush=True)
        if code:print(output[-5000:],flush=True)
    unchanged=all((ROOT/f).is_file() and hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=unchanged and all(r['exit_code']==0 and r['tests'] for r in results)
    report={'status':'passed' if passed else 'failed','recorded_at':datetime.now(timezone.utc).isoformat(),'checks':results,'total_tests':sum(r['tests'] or 0 for r in results),'source_hashes':hashes,'sources_unchanged':unchanged,
        'provider_validation':'HTTP protocol fixture, not a real Codex account or actual native provider process','real_model_calls':0,'credential_files_read':False,'stable_backend_modified':False,'manual_visual_review':False}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'evidence/WB002-4/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('WB0024_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True)
    return 0 if passed else 1
if __name__=='__main__':raise SystemExit(main())
