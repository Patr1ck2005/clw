"""Source-bound sustained Goal checks; no real models or stable activation."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,json,os,re,subprocess,sys
from verify_runtime_releases import source_hashes
ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--new-only',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-6/G3/runs'/stamp;run.mkdir(parents=True)
    env=dict(os.environ,PYTHONUTF8='1',CLW_GOAL_EVIDENCE_DIR=str(run/'screenshots'));env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
    before=source_hashes();checks=[]
    suites=[] if args.new_only else [('retained-regression',[sys.executable,'-B','scripts/verify_resource_workbench.py'])]
    suites += [(name,[sys.executable,'-B','tests/test_'+name+'.py']) for name in ('goals','goal_browser')]
    for name,argv in suites:
        try:
            process=subprocess.run(argv,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=1100);code=process.returncode;text=process.stdout+process.stderr
        except subprocess.TimeoutExpired:code=-1;text='Deadline exceeded; retain original execution and inspect before retry.'
        retained=None
        if name=='retained-regression':
            retained=(ROOT/'evidence/WB002-6/G4/latest-run.txt').read_text().strip()+'/verification.json';report=json.loads((ROOT/retained).read_text(encoding='utf-8'));count=report['total_tests']
            if report['status']!='passed' or report['source_hashes']!=before:code=code or 1
        else:
            match=re.search(r'Ran (\d+) tests?',text);count=int(match[1]) if match else 0
        log=run/(name+'.log');log.write_text(text,encoding='utf-8');checks.append({'name':name,'exit_code':code,'tests':count,'log':log.relative_to(ROOT).as_posix(),'retained_report':retained})
        print(name,code,'tests',count,flush=True)
        if code:print(text[-6500:],flush=True)
    unchanged=before==source_hashes();report={'status':'passed' if unchanged and all(c['exit_code']==0 and c['tests']>0 for c in checks) else 'failed','total_tests':sum(c['tests'] for c in checks),'new_only':args.new_only,'checks':checks,'source_hashes':before,'sources_unchanged':unchanged,'model_calls':0,'stable_activation':False,'real_sustained_goal_pilot_verified':False,'recorded_at':datetime.now(timezone.utc).isoformat()}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-6/G3/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('GOAL_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True);return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
