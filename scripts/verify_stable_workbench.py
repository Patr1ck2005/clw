"""Accept an already user-linked, running workbench through credential-free loopback GETs.
No credential file, upstream database, user browser profile or game files are read.
Only the current product's chosen Session is inspected; no backend tasks are launched.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from live_transport import validate_origin
from native_identity import SESSION_RE

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 2 * 1024 * 1024 + 32768
SECRET = re.compile(r'(?:wck_|wc_pat_|wc_oat_|wc_agent_|sk-)[A-Za-z0-9_-]{16,}')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, *args, **kwargs):
        fp.close()
        raise RuntimeError('Unexpected workbench redirect')

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--client-id', required=True)
    a = parser.parse_args()
    origin = validate_origin(a.url)
    if a.project != 'agent:' + a.client_id + ':clw-webcodex':
        parser.error('This acceptance is scoped to clw-webcodex only')
    if not SESSION_RE.fullmatch(a.session):
        parser.error('Explicit existing Session is required')
    root = Path.cwd().resolve()
    if root != ROOT:
        parser.error('Run from the product repository root')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    evidence = ROOT / 'evidence/WB002-2/stable' / stamp
    evidence.mkdir(parents=True)
    checks = []
    summary = {'kind':'user-linked stable workbench acceptance', 'user_stable_connection':True,
               'workbench_origin':origin, 'project_id':a.project, 'session_id':a.session,
               'base_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
               'checks':checks, 'credential_files_read':False, 'backend_mutations':False,
               'game_files_read_or_written':False, 'paid_model_calls':0,
               'visual_review':'Screenshots saved as evidence; automated DOM checks, not a new visual design review.'}
    opener = build_opener(ProxyHandler({}), NoRedirect())
    def check(name, condition):
        checks.append({'name':name,'passed':bool(condition)})
        if not condition:
            raise AssertionError(name)
    def get(path):
        with opener.open(Request(origin + path,headers={'Accept':'application/json'}),timeout=28) as response:
            if response.headers.get_content_type() != 'application/json':
                raise ValueError('Unexpected response media type')
            raw = response.read(MAX_BYTES+1)
            if len(raw) > MAX_BYTES or SECRET.search(raw.decode('utf-8')):
                raise ValueError('Unsafe response not recorded')
            data = json.loads(raw)
            if not isinstance(data,dict):
                raise ValueError('Unexpected response shape')
            return data
    browser = context = pw = None
    try:
        baseline = json.loads((ROOT/'evidence/WB002-2/managed-link-check.json').read_text(encoding='utf-8'))
        regression = json.loads((ROOT/baseline['regression']).read_text(encoding='utf-8'))
        mismatches = []
        for file, sha in regression['source_hashes'].items():
            p = (ROOT/file).resolve()
            if not p.is_relative_to(ROOT) or hashlib.sha256(p.read_bytes()).hexdigest() != sha:
                mismatches.append(file)
        check('Prior tested product sources remain unchanged', not mismatches)
        summary['regression_tests_reused_by_hash'] = regression['total_tests']
        summary['tested_source_files_verified'] = len(regression['source_hashes'])
        check('Explicit local connection reference exists', (ROOT/'.local/control-center/connection.json').is_file())
        info = get('/api/live/info')
        check('Running workbench is configured and read-only', info.get('configured') is True and info.get('read_only') is True and info.get('automatic_actions') is False)
        state = get('/api/live/state')
        check('Workbench observes stable Runner and version', state.get('state') == 'connected' and state['projection']['runtime']['runner_id'] == a.client_id and state['projection']['runtime']['version'] == '0.4.1')
        check('Connection identity matches info', state.get('connection_id') == info.get('connection_id'))
        projects = state['projection']['projects']
        check('Actual product is present in visible projects', any(p['id']==a.project for p in projects))
        summary.update(visible_project_count=len(projects),project_coverage=state['coverage']['projects'],
                       runtime=state['projection']['runtime'],connection_id=info['connection_id'])
        selected = {'project':a.project,'session':a.session}
        detail = get('/api/live/state?' + urlencode(selected))
        check('Exact existing Session is returned', detail.get('state')=='connected' and any(s['id']==a.session and s['project_id']==a.project and s['activities_loaded'] for s in detail['projection']['sessions']))
        session = next(s for s in detail['projection']['sessions'] if s['id']==a.session)
        check('Nonempty source activity is bounded and honest', bool(session['activities']) and len(session['activities'])<=200 and session['counts_available'] is False)
        check('All observed Jobs belong to chosen Project', all(j['project_id']==a.project for j in detail['projection']['jobs']))
        summary.update(session_count=len(detail['projection']['sessions']),activity_returned=len(session['activities']),activity_total=session['activity_total'],
                       job_count=len(detail['projection']['jobs']),coverage=detail['coverage'],observed_at=detail['observed_at'])
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        browser = pw.chromium.launch(channel='msedge',headless=True)
        context = browser.new_context(viewport={'width':1480,'height':1120})
        page = context.new_page()
        errors = [];requests = []
        page.on('pageerror',lambda error:errors.append(type(error).__name__))
        page.on('request',lambda request:requests.append((request.method,request.url)))
        page.goto(origin+'/?live=1')
        page.wait_for_function("() => document.querySelector('#liveState').dataset.state === 'connected'")
        page.locator(f'[data-project-id="{a.project}"]').click()
        page.wait_for_function("() => !document.querySelector('#sessionLookup').hidden && document.querySelector('#liveState').dataset.state === 'connected'")
        page.locator('#lookupSession').fill(a.session)
        page.locator('#lookupSessionButton').click()
        page.wait_for_function("sid => document.querySelector('#timelineSession').value === sid && document.querySelector('#timelineSummary').textContent.startsWith('当前Session活动') && document.querySelector('#liveState').dataset.state === 'connected'",arg=a.session)
        check('Real browser renders exact Session activity', page.locator('#eventRows tr').count()>0 and page.locator('#timelineSession').input_value()==a.session)
        before = page.locator('#sourceDetail').inner_text()
        page.wait_for_function("before => document.querySelector('#sourceDetail').textContent !== before && document.querySelector('#liveState').dataset.state === 'connected'",arg=before,timeout=22000)
        check('Automatic foreground refresh advances observation time', page.locator('#sourceDetail').inner_text()!=before)
        check('Live data is not presented as a snapshot', '正式只读接口' in page.locator('#sourceTitle').inner_text())
        page.screenshot(path=str(evidence/'stable-session-timeline.png'),full_page=True)
        page.locator('[data-view=overview]').click()
        page.screenshot(path=str(evidence/'stable-project-overview.png'),full_page=True)
        page.locator('#pauseLive').click()
        page.wait_for_timeout(500)
        count = len(requests)
        page.wait_for_timeout(5600)
        check('Pausing stops only observation requests', len(requests)==count and page.locator('#liveState').get_attribute('data-state')=='paused')
        check('Browser makes only same-workbench GET requests', all(method=='GET' and url.startswith(origin+'/') for method,url in requests))
        check('No script errors or credential patterns in DOM/storage', not errors and SECRET.search(page.content()) is None and SECRET.search(page.evaluate('() => JSON.stringify(localStorage)')) is None)
        summary['browser_http_request_count'] = len(requests)
        summary['status'] = 'passed'
    except Exception as exc:
        summary['status'] = 'failed'
        summary['failure_type'] = type(exc).__name__
        summary['message'] = 'Stable acceptance did not finish; existing connection was not modified. No raw error/response was recorded.'
    finally:
        if context:context.close()
        if browser:browser.close()
        if pw:pw.stop()
        summary['recorded_at'] = datetime.now(timezone.utc).isoformat()
        summary['validator_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        (evidence/'verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        (ROOT/'evidence/WB002-2/latest-stable.txt').write_text(evidence.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
        print(json.dumps(summary,ensure_ascii=False,indent=2))
        print('STABLE_EVIDENCE',evidence.relative_to(ROOT).as_posix(),flush=True)
    return 0 if summary['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
