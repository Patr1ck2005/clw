"""Source-bound G4 checks; never operates a live pilot or model."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,json,os,re,subprocess,sys
from verify_runtime_releases import source_hashes
ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser();p.add_argument('--core-only',action='store_true');p.add_argument('--new-only',action='store_true');a=p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-6/G4/runs'/stamp;run.mkdir(parents=True)
    env=dict(os.environ,PYTHONUTF8='1',CLW_RESOURCE_EVIDENCE_DIR=str(run/'screenshots'));env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
    before=source_hashes();rows=[]
    suites=[] if a.core_only or a.new_only else [('retained-regression',[sys.executable,'-B','scripts/verify_collaboration.py'])]
    names=['resources'] if a.core_only else ['resources','resource_worker','resource_http','resource_browser']
    suites += [(name,[sys.executable,'-B','tests/test_'+name+'.py']) for name in names]
    for name,cmd in suites:
        try:
            r=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=900);code=r.returncode;output=r.stdout+r.stderr
        except subprocess.TimeoutExpired:code=-1;output='Deadline exceeded. Reconcile original child state; no retry.'
        count=0;retained=None
        if name=='retained-regression':
            retained=(ROOT/'evidence/WB002-6/G1/latest-run.txt').read_text().strip()+'/verification.json'
            report=json.loads((ROOT/retained).read_text(encoding='utf-8'));count=report['total_tests']
            if report['status']!='passed' or report['source_hashes']!=before:code=code or 1
        else:
            match=re.search(r'Ran (\d+) tests?',output);count=int(match[1]) if match else 0
        log=run/(name+'.log');log.write_text(output,encoding='utf-8')
        rows.append({'name':name,'exit_code':code,'tests':count,'log':log.relative_to(ROOT).as_posix(),'retained_report':retained})
        print(name,code,'tests',count,flush=True)
        if code:print(output[-7000:],flush=True)
    unchanged=before==source_hashes()
    report={'status':'passed' if unchanged and all(x['exit_code']==0 and x['tests']>0 for x in rows) else 'failed','total_tests':sum(x['tests'] for x in rows),'core_only':a.core_only,'new_only':a.new_only,'checks':rows,'source_hashes':before,'sources_unchanged':unchanged,'recorded_at':datetime.now(timezone.utc).isoformat(),'model_calls':0,'stable_activation':False,'pilot_business_verified':False,'host_auto_resume_verified':False}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'evidence/WB002-6/G4/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('G4_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
