"""WB002.5 retained regression plus isolated image/HTTP/Edge lifecycle tests. No providers."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,os,re,shutil,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--new-only',action='store_true');args=p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-5/runs'/stamp;run.mkdir(parents=True)
    env=os.environ.copy();env['PYTHONUTF8']='1';env.pop('CLW_WEBCODEX_TOKEN',None)
    for var,folder in [('CLW_TEST_EVIDENCE_DIR','WB002-2'),('CLW_TASK_EVIDENCE_DIR','WB002-3'),('CLW_SPECIALIST_EVIDENCE_DIR','WB002-4'),('CLW_ACCOUNT_EVIDENCE_DIR','WB002-4A')]:env[var]=str(ROOT/'evidence'/folder/'runs'/('wb0025-'+stamp)/'screenshots')
    env['CLW_ASSET_EVIDENCE_DIR']=str(run/'screenshots')
    paths=[p for folder in ('apps/control-center','scripts','tests') for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    js=['asset-client'];py=['assets','asset_http','asset_browser']
    if not args.new_only:
        js=['control-center','live','task-client','journal-client','account-view']+js
        py=['control_center','live_observer','workbench_link','live_browser','task_store','task_http','task_browser','specialists','usage_store','specialist_http','specialist_browser','ingress_health','accounts','account_http','account_browser']+py
    suites=[('node-'+n,[shutil.which('node'),'--test','--test-reporter=tap','tests/'+n+'.test.mjs']) for n in js]+[(n,[sys.executable,'-B','tests/test_'+n+'.py']) for n in py]
    results=[]
    for name,cmd in suites:
        try:
            p=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=240);code=p.returncode;output=p.stdout+p.stderr
        except subprocess.TimeoutExpired:code=-1;output='Test deadline exceeded; no success claimed.'
        m=re.search(r'# tests (\d+)',output) if name.startswith('node-') else re.search(r'Ran (\d+) tests?',output)
        count=int(m[1]) if m else None;(run/(name+'.log')).write_text(output,encoding='utf-8');results.append({'name':name,'exit_code':code,'tests':count,'log':(run/(name+'.log')).relative_to(ROOT).as_posix()})
        print(name,code,'tests',count,flush=True)
        if code:print(output[-8000:],flush=True)
    same=all((ROOT/f).is_file() and hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=same and all(r['exit_code']==0 and r['tests'] for r in results)
    report={'status':'passed' if passed else 'failed','new_only':args.new_only,'recorded_at':datetime.now(timezone.utc).isoformat(),'total_tests':sum(r['tests'] or 0 for r in results),'checks':results,'source_hashes':hashes,'sources_unchanged':same,'real_model_calls':0,'credential_files_read':False,'stable_backend_modified':False,'coverage':'temporary SQLite, real PNG/JPEG/WebP bytes, real loopback HTTP and isolated Edge; not actual provider generation or production integration','manual_visual_review':False}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-5/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('WB0025_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True)
    return 0 if passed else 1
if __name__=='__main__':raise SystemExit(main())
