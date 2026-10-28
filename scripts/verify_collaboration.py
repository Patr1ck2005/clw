"""G1 source-bound isolated regression; never activates the live product or models."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import re
import subprocess
import sys
from verify_runtime_releases import source_hashes
ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--new-only',action='store_true');parser.add_argument('--core-only',action='store_true');args=parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run=ROOT/'evidence/WB002-6/G1/runs'/stamp;run.mkdir(parents=True)
    env=dict(os.environ,PYTHONUTF8='1',CLW_COLLAB_EVIDENCE_DIR=str(run/'screenshots'));env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
    before=source_hashes();rows=[]
    suites=[] if args.new_only or args.core_only else [('retained-regression',[sys.executable,'-B','scripts/verify_runtime_releases.py'])]
    names=['collaboration'] if args.core_only else ['collaboration','task_worker','task_console','collaboration_browser']
    suites += [(name,[sys.executable,'-B','tests/test_'+name+'.py']) for name in names]
    for name,command in suites:
        try:
            r=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=720)
            output=r.stdout+r.stderr;code=r.returncode
        except subprocess.TimeoutExpired:output='Deadline exceeded; no automatic retry.';code=-1
        count=0;retained=None
        if name=='retained-regression':
            latest=(ROOT/'evidence/WB002-6/G0/latest-run.txt').read_text().strip()+'/verification.json';retained=latest
            report=json.loads((ROOT/latest).read_text(encoding='utf-8'));count=report['total_tests']
            if report['status']!='passed' or report['source_hashes']!=before:code=code or 1
        else:
            match=re.search(r'Ran (\d+) tests?',output);count=int(match[1]) if match else 0
        log=run/(name+'.log');log.write_text(output,encoding='utf-8')
        rows.append({'name':name,'exit_code':code,'tests':count,'log':log.relative_to(ROOT).as_posix(),'retained_report':retained})
        print(name,code,'tests',count,flush=True)
        if code:print(output[-6000:],flush=True)
    unchanged=before==source_hashes()
    report={'status':'passed' if unchanged and all(r['exit_code']==0 and r['tests']>0 for r in rows) else 'failed','new_only':args.new_only,'core_only':args.core_only,
            'total_tests':sum(r['tests'] for r in rows),'checks':rows,'source_hashes':before,'sources_unchanged':unchanged,'recorded_at':datetime.now(timezone.utc).isoformat(),
            'real_model_calls':0,'stable_activation':False,'real_independent_web_workers_verified':False,'host_auto_resume_verified':False}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (ROOT/'evidence/WB002-6/G1/latest-run.txt').write_text(run.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('G1_VERIFICATION',run.relative_to(ROOT).as_posix(),report['status'],report['total_tests'],flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
