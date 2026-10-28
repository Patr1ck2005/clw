"""Narrow new-control acceptance; NOT a substitute for the pending full suite.

Only new isolated core/launcher/companion/HTTP fixtures. No real model sends,
no production service startup, no browser profile attachment. Timestamped logs.
"""
from pathlib import Path
from datetime import datetime,timezone
import ast,hashlib,json,re,subprocess,sys,os
ROOT=Path(__file__).resolve().parents[1]
FILES=['scripts/harness_control_plane.py','scripts/harness_control_http.py','scripts/harness_launcher.py','scripts/harness_host.py','scripts/harness_host_client.py','scripts/harness_service.py','scripts/harness_http.py','scripts/harness_handoff.py','scripts/harness_collaboration.py','scripts/harness_recovery.py','scripts/serve_harness.py','scripts/serve_control_center.py','scripts/verify_control_core.py','scripts/product_runtime.py','scripts/harness_state.py','START_HARNESS.cmd','STOP_HARNESS.cmd','apps/control-center/harness-ui.mjs','apps/control-center/harness.html','tests/test_harness_control_plane.py','tests/test_harness_control_http.py','tests/test_harness_launcher.py','tests/control-companion.test.mjs','tests/unified-companion.test.mjs','tests/harness-recovery-content.test.mjs']

def main():
    run=ROOT/'evidence/CONTROL-CORE-20260923/runs'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ');run.mkdir(parents=True)
    paths=[ROOT/f for f in FILES]+sorted((ROOT/'apps/web-control-companion').glob('*'))+sorted((ROOT/'apps/web-recovery-companion').glob('*'))
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    for p in paths:
        if p.suffix=='.py':ast.parse(p.read_text(encoding='utf-8'),filename=str(p))
        if p.suffix=='.json':json.loads(p.read_text(encoding='utf-8'))
    db=ROOT/'.local/harness/harness.sqlite3'
    before=hashlib.sha256(db.read_bytes()).hexdigest() if db.exists() else None
    suites=[('control-state',[sys.executable,'-X','utf8','-B','tests/test_harness_control_plane.py']),('launcher',[sys.executable,'-X','utf8','-B','tests/test_harness_launcher.py']),('companion',['node','--test','tests/control-companion.test.mjs']),('unified-companion',['node','--test','tests/unified-companion.test.mjs']),('recovery-compat',['node','--test','tests/harness-recovery-content.test.mjs']),('control-http-browser',[sys.executable,'-X','utf8','-B','tests/test_harness_control_http.py'])]
    results=[]
    for name,cmd in suites:
        try:
            r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120,env={**os.environ,'CLW_CONTROL_TEST_DIR':str(run)});code=r.returncode;log=r.stdout+r.stderr
        except subprocess.TimeoutExpired:code=-1;log='New-control isolated suite timed out. No real model request was sent.'
        (run/(name+'.log')).write_text(log[:1024*1024],encoding='utf-8')
        match=re.search(r'(?:Ran |# tests |ℹ tests )(\d+)',log)
        item={'suite':name,'exit_code':code,'tests':int(match[1]) if match else 0,'log_truncated':len(log)>1024*1024};results.append(item)
        print(json.dumps(item),flush=True)
        if code:print(log[-4000:],flush=True)
    same=all(hashlib.sha256(p.read_bytes()).hexdigest()==hashes[p.relative_to(ROOT).as_posix()] for p in paths)
    unchanged=(hashlib.sha256(db.read_bytes()).hexdigest() if db.exists() else None)==before
    report={'format':'clw.control-core-isolated.v2','status':'passed' if same and unchanged and all(r['exit_code']==0 and r['tests']>0 for r in results) else 'failed','suites':results,'tests':sum(r['tests'] for r in results),'source_hashes':hashes,'sources_unchanged':same,'original_store_bytes_unchanged':unchanged,'model_calls':0,'real_web_acceptance':False,'full_previous_suite_rerun':False,'scope':'control state machine, launcher, unified shipped 0.2.2 companion with current ChatGPT DOM adaptation and wrong-page guard, legacy recovery compatibility, and isolated HTTP/Edge only'}
    (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'report':(run/'verification.json').relative_to(ROOT).as_posix(),'status':report['status'],'tests':report['tests'],'sources_unchanged':same}),flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
