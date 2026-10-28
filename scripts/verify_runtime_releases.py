"""G0 full regression + generic pilot/resource metadata, fixed release and real Edge checks."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,os,re,shutil,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]

def source_hashes():
    paths=[p for d in ('apps/control-center','scripts','tests','config') for p in (ROOT/d).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    paths += [ROOT/p for p in ('package.json','START_WORKBENCH.cmd','MANAGE_WORKBENCH.cmd','CONNECT_WORKBENCH.cmd','LINK_DESKTOP_WORKBENCH.cmd','MAINTAIN_EXISTING_MCP.cmd')]
    return {p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(paths))}

def main():
    p=argparse.ArgumentParser();p.add_argument('--new-only',action='store_true');args=p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-6/G0/runs'/stamp;run.mkdir(parents=True)
    env=os.environ.copy();env['PYTHONUTF8']='1';env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
    for var,folder in [('CLW_TEST_EVIDENCE_DIR','WB002-2'),('CLW_TASK_EVIDENCE_DIR','WB002-3'),('CLW_SPECIALIST_EVIDENCE_DIR','WB002-4'),('CLW_ACCOUNT_EVIDENCE_DIR','WB002-4A'),('CLW_ASSET_EVIDENCE_DIR','WB002-5')]:
        env[var]=str(ROOT/'evidence'/folder/'runs'/('wb0026g0-'+stamp)/'screenshots')
    env['CLW_RELEASE_EVIDENCE_DIR']=str(run/'screenshots')
    before=source_hashes();js=['product-status'];py=['pilot_plan','runtime_releases','product_browser']
    if not args.new_only:
        js=['control-center','live','task-client','journal-client','account-view','asset-client']+js
        py=['control_center','live_observer','workbench_link','live_browser','task_store','task_http','task_browser','specialists','usage_store','specialist_http','specialist_browser','ingress_health','accounts','account_http','account_browser','assets','asset_http','asset_browser']+py
    suites=[('node-'+n,[shutil.which('node'),'--test','--test-reporter=tap','tests/'+n+'.test.mjs']) for n in js]+[(n,[sys.executable,'-B','tests/test_'+n+'.py']) for n in py]
    results=[]
    for name,cmd in suites:
        try:
            result=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=240);code=result.returncode;output=result.stdout+result.stderr
        except subprocess.TimeoutExpired:code=-1;output='Test deadline exceeded, not repeated or marked successful.'
        m=re.search(r'# tests (\d+)',output) if name.startswith('node-') else re.search(r'Ran (\d+) tests?',output)
        count=int(m[1]) if m else 0
        (run/(name+'.log')).write_text(output,encoding='utf-8');results.append({'name':name,'exit_code':code,'tests':count,'log':(run/(name+'.log')).relative_to(ROOT).as_posix()})
        print(name,code,'tests',count,flush=True)
        if code:print(output[-7000:],flush=True)
    same=source_hashes()==before
    report={'status':'passed' if same and all(x['exit_code']==0 and x['tests'] for x in results) else 'failed','total_tests':sum(x['tests'] for x in results),'new_only':args.new_only,'checks':results,'source_hashes':before,'sources_unchanged':same,'recorded_at':datetime.now(timezone.utc).isoformat(),'real_model_calls':0,'production_activation':False,'stable_backend_modified':False,'coverage':'temporary Git releases/data; real cross-process locks, SQLite receipts, loopback HTTP and isolated Edge; not host wake or pilot business execution'}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'evidence/WB002-6/G0/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('G0_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
