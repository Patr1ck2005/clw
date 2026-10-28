"""Source-bound product integration; actual native/Host/pilot reports are separate."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,json,os,re,subprocess,sys
from verify_runtime_releases import source_hashes
ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser();p.add_argument('--new-only',action='store_true');a=p.parse_args();sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    run=ROOT/'evidence/WB002-7/runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
    routing=ROOT/'evidence/WB002-6/G2/integrated-screenshots'/run.name;routing.mkdir(parents=True)
    env=dict(os.environ,PYTHONUTF8='1',CLW_ROUTING_EVIDENCE_DIR=str(routing));env.pop('PYTHONPATH',None);env.pop('CLW_WEBCODEX_TOKEN',None)
    before=source_hashes();checks=[];suites=[] if a.new_only else [('retained-regression',[sys.executable,'-B','scripts/verify_goal_workbench.py'])]
    suites += [(name,[sys.executable,'-B','tests/test_'+name+'.py']) for name in ('routing','communication_bridge','routing_browser','desktop_bundle','native_maintenance')]
    for name,argv in suites:
        try:r=subprocess.run(argv,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=1500);code=r.returncode;text=r.stdout+r.stderr
        except subprocess.TimeoutExpired:code=-1;text='Deadline exceeded; preserve original execution evidence before retry.'
        retained=None
        if name=='retained-regression':
            retained=(ROOT/'evidence/WB002-6/G3/latest-run.txt').read_text().strip()+'/verification.json';report=json.loads((ROOT/retained).read_text(encoding='utf-8'));count=report['total_tests']
            if report['status']!='passed' or report['source_hashes']!=before:code=code or 1
        else:
            match=re.search(r'Ran (\d+) tests?',text);count=int(match[1]) if match else 0
        log=run/(name+'.log');log.write_text(text,encoding='utf-8');checks.append({'name':name,'exit_code':code,'tests':count,'log':log.relative_to(ROOT).as_posix(),'retained_report':retained});print(name,code,'tests',count,flush=True)
        if code:print(text[-8000:],flush=True)
    unchanged=before==source_hashes();report={'status':'passed' if unchanged and all(c['exit_code']==0 and c['tests']>0 for c in checks) else 'failed','new_only':a.new_only,'total_tests':sum(c['tests'] for c in checks),'checks':checks,'source_hashes':before,'sources_unchanged':unchanged,'model_calls':0,'stable_activation':False,'real_host_acceptance':False,'pilot_activation':False,'recorded_at':datetime.now(timezone.utc).isoformat()}
    (run/'verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-7/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('INTEGRATED_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True);return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
