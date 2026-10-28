"""Bounded isolated validation; never starts production, real Web models or Codex.

Snapshots product/test sources, runs explicit suites, and checks additive migration
on a read-only backup CLONE of the original store. It does not alter old evidence.
"""
from __future__ import annotations
from contextlib import closing
from datetime import datetime,timezone
import ast,hashlib,json,os,re,sqlite3,subprocess,sys,tempfile,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SUITES=[
 ('team-core',[sys.executable,'-X','utf8','-B','tests/test_harness_team.py']),
 ('team-boundaries',[sys.executable,'-X','utf8','-B','tests/test_harness_team_boundaries.py']),
 ('team-safety',[sys.executable,'-X','utf8','-B','tests/test_harness_team_safety.py']),
 ('team-http-browser',[sys.executable,'-X','utf8','-B','tests/test_harness_team_http.py']),
 ('team-companion',['node','--test','tests/team-companion.test.mjs']),
 ('unified-companion',['node','--test','tests/unified-companion.test.mjs']),
 ('browser-result-companion',['node','--test','tests/browser-result-companion.test.mjs']),
 ('background-bridge',['node','--test','tests/background-bridge.test.mjs']),
 ('recovery-worker-compat',['node','--test','tests/harness-recovery-worker.test.mjs']),
 ('host-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_host.py']),
 ('collaboration-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_collaboration.py']),
 ('control-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_control_plane.py']),
 ('control-http-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_control_http.py']),
 ('handoff-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_handoff.py']),
 ('recovery-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_recovery.py']),
 ('recovery-page-compat',['node','--test','tests/harness-recovery-content.test.mjs']),
 ('launcher-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_launcher.py']),
 ('branch-api-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_branch_api.py']),
 ('service-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_service.py']),
 ('control-model-compat',[sys.executable,'-X','utf8','-B','tests/test_harness_control.py']),
 ('split-companion-compat',['node','--test','tests/control-companion.test.mjs'])]

def digest(data):return hashlib.sha256(data).hexdigest()
def source_files():
    from product_runtime import snapshot_payload
    raw=snapshot_payload(ROOT)
    extra=[ROOT/'scripts/verify_autonomous_runtime.py',ROOT/'scripts/verify_control_core.py']
    for folder in ['apps/web-recovery-companion','apps/web-control-companion']:
        extra.extend(x for x in (ROOT/folder).iterdir() if x.is_file() and x.suffix in ('.js','.json','.html','.css'))
    extra.extend((ROOT/'tests').glob('test_harness*.py'))
    extra.extend((ROOT/'tests').glob('*companion*.mjs'))
    extra.append(ROOT/'tests/harness-recovery-content.test.mjs')
    extra.append(ROOT/'tests/background-bridge.test.mjs')
    extra.append(ROOT/'tests/harness-recovery-worker.test.mjs')
    for p in extra:
        if p.is_symlink() or p.stat().st_size>2*1024*1024:raise ValueError('validation_source_bounds')
        raw[p.relative_to(ROOT).as_posix()]=p.read_bytes()
    return {k:digest(v) for k,v in sorted(raw.items())}

def original_business(path):
    if not path.exists():return {'store_missing':True}
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row
        ids=('clw-b-branch-acceptance-parent-20260923-v1','clw-child-f14d63d4e61870232845d1a9eb66af451779cfa2')
        return {'store_id':db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0],
          'requests':[dict(x) for x in db.execute('SELECT id,thread_id,phase,claim_id,cancel_requested FROM host_requests WHERE id IN (?,?) ORDER BY id',ids)],
          'delegation_count':db.execute('SELECT COUNT(*) FROM host_delegations WHERE parent_request_id=?',(ids[0],)).fetchone()[0],
          'in_flight_count':db.execute("SELECT COUNT(*) FROM control_attempts WHERE state IN ('dispatching','sent','unknown')").fetchone()[0]}

def clone_check(path):
    if not path.exists():return {'status':'not_available','production_modified':False}
    if path.stat().st_size>128*1024*1024:raise ValueError('original_store_too_large')
    sys.path.insert(0,str(ROOT/'tests'))
    from harness_service import HarnessService
    from test_harness_service import FakeConnection
    from test_harness_web import FakeBridge
    before=original_business(path)
    with tempfile.TemporaryDirectory(prefix='clw-team-migration-') as tmp:
        state=Path(tmp)/'state';state.mkdir();dest=state/'harness.sqlite3'
        with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as source,closing(sqlite3.connect(dest)) as db:source.backup(db)
        bridge=FakeBridge();bridge.denied=True
        service=HarnessService(ROOT,state,connection_factory=FakeConnection,web_bridge=bridge)
        try:
            after=original_business(dest)
            if before!=after:raise AssertionError('original_business_changed_in_migration')
            with closing(service.state.connect()) as db:
                count=db.execute('SELECT COUNT(*) FROM host_runs').fetchone()[0]
                tables={x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                check=db.execute('PRAGMA quick_check').fetchone()[0]
            if service.connection is not None or bridge.posts:raise AssertionError('unexpected_provider_use')
            if not {'host_carrier_links','host_runs','host_team_leases','host_context_imports'}<=tables:raise AssertionError('missing_team_schema')
            if check!='ok':raise AssertionError('clone_integrity')
            return {'status':'passed','store_id_preserved':True,'original_requests_claims_delegation_preserved':True,
                    'integrity':'ok','existing_runs':count,'models':0,'production_modified':False}
        finally:service.close()

def run_suite(name,args,out):
    env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','CLW_AUTONOMOUS_TEST_DIR':str(out),'CLW_CONTROL_TEST_DIR':str(out)}
    log=out/(name+'.log');kept=0;dropped=0;tail=bytearray();started=time.monotonic();error=None
    with log.open('xb') as stream:
        child=subprocess.Popen(args,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env)
        def drain():
            nonlocal kept,dropped,tail
            while True:
                data=child.stdout.read(8192)
                if not data:return
                n=min(len(data),max(0,1024*1024-kept));stream.write(data[:n]);kept+=n;dropped+=len(data)-n
                tail.extend(data);del tail[:-65536]
        reader=threading.Thread(target=drain,daemon=True);reader.start()
        try:code=child.wait(timeout=240)
        except subprocess.TimeoutExpired:
            child.kill();code=child.wait(timeout=10);error='suite_timeout_owned_process_killed'
        reader.join(timeout=5)
        if reader.is_alive():error='suite_log_reader_incomplete'
        child.stdout.close()
    text=tail.decode('utf-8',errors='replace')
    python=re.findall(r'Ran (\d+) tests?',text);node=re.findall(r'(?:ℹ|#) tests (\d+)',text)
    count=int((python or node or ['0'])[-1])
    result={'suite':name,'exit_code':code,'tests':count,'passed':code==0 and count>0 and not error and not dropped,
        'seconds':round(time.monotonic()-started,3),'log':log.name,'log_dropped_bytes':dropped,'error':error}
    print(json.dumps(result),flush=True);return result

def main():
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    out=ROOT/'evidence/AUTONOMOUS-RUNTIME-20260924/runs'/stamp;out.mkdir(parents=True)
    original=ROOT/'.local/harness/harness.sqlite3';before_business=original_business(original)
    before_bytes=digest(original.read_bytes()) if original.exists() else None
    initial=source_files();suites=[];clone=None;error=None
    try:
        for path in initial:
            if path.endswith('.py'):ast.parse((ROOT/path).read_text(encoding='utf-8-sig'),filename=path)
        for p in [ROOT/'apps/web-recovery-companion/manifest.json',ROOT/'config/team-intake.example.json']:json.loads(p.read_text(encoding='utf-8'))
        clone=clone_check(original)
        for name,args in SUITES:suites.append(run_suite(name,args,out))
        final=source_files()
    except Exception as exc:
        error=type(exc).__name__+':'+str(exc)[:400];final=source_files()
    same=initial==final;business_same=before_business==original_business(original)
    bytes_same=before_bytes==(digest(original.read_bytes()) if original.exists() else None)
    status='passed' if len(suites)==len(SUITES) and all(x['passed'] for x in suites) and same and business_same and not error and clone and clone['status']=='passed' else 'failed'
    report={'format':'clw.autonomous-runtime-validation.v1','status':status,'suites':suites,'tests':sum(x['tests'] for x in suites),
      'clone_migration':clone,'source_hashes':initial,'sources_unchanged':same,'original_business_requests_unchanged':business_same,
      'original_store_bytes_unchanged':bytes_same,'live_background_heartbeat_may_change_store_bytes':True,'error':error,
      'model_calls':0,'production_started_or_restarted':False,'real_web_acceptance':False,'business_projects_accessed':False,
      'scope':'new team runtime + relevant legacy compatibility using isolated actors/HTTP/Edge; no native provider/model trial'}
    (out/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'report':str((out/'verification.json').relative_to(ROOT)),'status':status,'tests':report['tests'],'sources_unchanged':same,'error':error}),flush=True)
    return 0 if status=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
