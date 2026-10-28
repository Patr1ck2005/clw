"""Run the scoped Control Center regression; retain every attempt and its source hashes."""
from pathlib import Path
import subprocess,sys,json,hashlib,datetime,shutil,os
ROOT=Path(__file__).resolve().parents[1]
def main():
 sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
 os.environ['PYTHONUTF8']='1'
 e=ROOT/'evidence/WB002-1';e.mkdir(exist_ok=True,parents=True)
 run=e/'runs'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
 os.environ['CLW_TEST_EVIDENCE_DIR']=str((run/'screenshots').resolve())
 subprocess.run([sys.executable,'-B',str(ROOT/'scripts/build_observation_sample.py')],cwd=ROOT,check=True)
 files=[p for folder in ['apps/control-center','scripts','tests'] for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
 hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
 checks=[]
 for name,args in [('node-model',[shutil.which('node'),'--test','tests/control-center.test.mjs']),('python-server-browser',[sys.executable,'-B','tests/test_control_center.py'])]:
  try:
   p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=200)
   output=p.stdout+p.stderr;code=p.returncode
  except subprocess.TimeoutExpired:
   output='Regression harness subprocess timed out; retained as failure, not automatically repeated.';code=-1
  log=run/(name+'.log');log.write_text(output,encoding='utf-8');checks.append({'name':name,'exit_code':code,'log':log.relative_to(ROOT).as_posix()})
  print(name,code,flush=True);print(output[-8500:],flush=True)
 unchanged=all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==h for p,h in hashes.items())
 report={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,'source_hashes':hashes,'sources_unchanged_during_run':unchanged,'browser_evidence_dir':str((run/'screenshots').relative_to(ROOT)),'stable_backend_modified':False,'model_or_api_calls':0,'status':'passed' if unchanged and all(x['exit_code']==0 for x in checks) else 'failed'}
 (run/'verification.json').write_text(json.dumps(report,indent=2)+'\n');(e/'latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n');print('VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],flush=True)
 return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
