"""Scoped regression with immutable timestamped evidence; never invokes models."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,os,re,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--include-rpc',action='store_true');args=parser.parse_args()
    run=ROOT/'evidence/HARNESS-MVP-20260922/runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
    files=[*list((ROOT/'scripts').glob('harness_*.py')),ROOT/'scripts/serve_harness.py',ROOT/'scripts/communication_bridge.py',ROOT/'scripts/serve_control_center.py',*list((ROOT/'apps/control-center').glob('harness*')),*list((ROOT/'tests').glob('*harness*')),ROOT/'tests/test_communication_bridge.py',ROOT/'package.json']
    files.extend((ROOT/'apps/web-recovery-companion').glob('*'))
    files.extend([ROOT/'START_HARNESS.cmd',ROOT/'tests/test_control_center.py'])
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
    suites=[('service',[sys.executable,'-X','utf8','-B','tests/test_harness_service.py']),('model',['node','--test','tests/harness-model.test.mjs','tests/harness-host-model.test.mjs','tests/harness-recovery-policy.test.mjs','tests/harness-recovery-worker.test.mjs','tests/harness-recovery-content.test.mjs','tests/harness-branch-model.test.mjs']),('communication',[sys.executable,'-X','utf8','-B','tests/test_communication_bridge.py']),('routing',[sys.executable,'-X','utf8','-B','tests/test_routing.py']),('legacy-http',[sys.executable,'-X','utf8','-B','tests/test_control_center.py'])]
    if args.include_rpc:suites.insert(0,('rpc',[sys.executable,'-X','utf8','-B','tests/test_harness_rpc.py']))
    suites.append(('control',[sys.executable,'-X','utf8','-B','tests/test_harness_control.py']))
    suites.append(('native-web',[sys.executable,'-X','utf8','-B','tests/test_harness_web.py']))
    suites.append(('project-host',[sys.executable,'-X','utf8','-B','tests/test_harness_host.py']))
    suites.append(('collaboration',[sys.executable,'-X','utf8','-B','tests/test_harness_collaboration.py']))
    suites.append(('handoff',[sys.executable,'-X','utf8','-B','tests/test_harness_handoff.py']))
    suites.append(('branch-api',[sys.executable,'-X','utf8','-B','tests/test_harness_branch_api.py']))
    suites.append(('recovery',[sys.executable,'-X','utf8','-B','tests/test_harness_recovery.py']))
    suites.append(('recovery-diagnostics',[sys.executable,'-X','utf8','-B','tests/test_harness_recovery_diagnostics.py']))
    results=[]
    for name,cmd in suites:
        try:
            result=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=180)
            code=result.returncode;output=result.stdout+result.stderr
        except subprocess.TimeoutExpired:code=-1;output='Suite deadline exceeded; original process not replayed.'
        (run/(name+'.log')).write_text(output,encoding='utf-8')
        match=re.search(r'(?:Ran |# tests |ℹ tests )(\d+)',output)
        results.append({'name':name,'exit_code':code,'tests':int(match[1]) if match else 0})
        print(name,code,'tests',results[-1]['tests'],flush=True)
        if code:print(output[-6000:],flush=True)
    unchanged=all(p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==hashes[p.relative_to(ROOT).as_posix()] for p in files if p.relative_to(ROOT).as_posix() in hashes)
    report={'status':'passed' if unchanged and all(r['exit_code']==0 and r['tests']>0 for r in results) else 'failed','checks':results,'total_tests':sum(r['tests'] for r in results),'source_hashes':hashes,'sources_unchanged':unchanged,'actual_model_calls':0,'real_host_acceptance':False,'scope':'transport/service/HTTP/view-model and impacted legacy tests; not browser visual or actual model/Host acceptance'}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'report':(run/'verification.json').relative_to(ROOT).as_posix(),'status':report['status'],'tests':report['total_tests'],'sources_unchanged':unchanged}),flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
