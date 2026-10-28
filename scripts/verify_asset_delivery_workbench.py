"""Actual read-only project discovery + isolated parent/asset/image/ZIP acceptance.
Only the already-linked workbench is read. No provider requests, credentials or production writes.
"""
from __future__ import annotations
from datetime import datetime,timezone
from io import BytesIO
from pathlib import Path
import argparse,hashlib,json,subprocess,sys,threading,uuid,zipfile
from urllib.request import Request,build_opener,ProxyHandler
from urllib.error import HTTPError
from urllib.parse import urlencode,quote
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
from PIL import Image
from playwright.sync_api import sync_playwright
from verify_dual_ingress_workbench import ObserverRelay,processes
from live_transport import NoRedirect
from asset_store import AssetStore
from task_store import TaskStore
from task_domain import fingerprint
from serve_control_center import create_server
from test_assets import sample,raster
from test_task_store import example

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--observer-origin',default='http://127.0.0.1:18940')
    parser.add_argument('--project',required=True)
    a=parser.parse_args();sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    if not a.project.endswith(':clw-webcodex'):parser.error('Acceptance only observes the product project')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    out=ROOT/'evidence/WB002-5/delivery'/stamp;out.mkdir(parents=True)
    local=ROOT/'.local/WB0025-delivery'/stamp;local.mkdir(parents=True)
    paths=[p for d in ('apps/control-center','scripts','tests') for p in (ROOT/d).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    checks=[];server=None;thread=None;before=processes();report={'status':'failed'}
    def check(name,value):
        checks.append({'name':name,'passed':bool(value)})
        if not value:raise AssertionError(name)
    try:
        observer=ObserverRelay(a.observer_origin);info=observer.info();state=observer.state(a.project)
        check('existing_observer_is_configured_read_only',info.get('configured') and info.get('read_only'))
        check('actual_backend_is_connected',state.get('state')=='connected')
        project=next((p for p in state['projection']['projects'] if p['id']==a.project),None)
        check('actual_exact_product_project',project is not None)
        report.update(project_id=project['id'],project_root=project['path'],project_count=len(state['projection']['projects']),observed_at=state['observed_at'])
        tasks=TaskStore(local/'tasks.sqlite3',observer);parent_contract=example(path=project['path'])
        parent_contract.update(title='WB002.5 isolated acceptance parent',goal='Verify candidate delivery only; no changes to actual project',sources='Locally generated test fixtures, no model generation')
        parent_contract['roles'][0]['project_id']=project['id']
        parent=tasks.command({'request_id':str(uuid.uuid4()),'actor':'isolated verifier','action':'create','data':{'contract':parent_contract}})['task']
        store=AssetStore(local/'assets.sqlite3',tasks,observer)
        server=create_server(observer=observer,task_store=tasks,asset_store=store)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();origin='http://127.0.0.1:'+str(server.server_address[1])
        opener=build_opener(ProxyHandler({}),NoRedirect());posts=[]
        def request(route,method='GET',body=None,headers=None):
            full=origin+'/api/assets/'+route
            h={'Origin':origin,'X-CLW-Intent':server.asset_api.intent,'Content-Type':'application/json'};h.update(headers or {})
            if method=='POST':posts.append(route)
            try:response=opener.open(Request(full,data=body,method=method,headers=h),timeout=15)
            except HTTPError as exc:response=exc
            with response:return response.status,response.read(70*1024*1024),response.headers.get_content_type()
        def get(route):
            code,data,_=request(route);check('get_'+route.split('?')[0],code==200);return json.loads(data)
        def command(action,b=None,data=None):
            raw={'request_id':str(uuid.uuid4()),'actor':'isolated acceptance, fixture evidence only','action':action,'data':data or {}}
            if b:raw.update(batch_id=b['id'],expected_version=b['version'])
            code,result,_=request('command','POST',json.dumps(raw).encode());check('command_'+action,code==200)
            return json.loads(result)['batch']
        check('assets_explicitly_do_not_dispatch',get('info')['model_calls'] is False)
        check('asset_project_picker_uses_actual_source',any(p['id']==project['id'] for p in get('projects')['projects']))
        c=sample(True,('badge','panel'));c.update(title='交付验收 · 双素材 / 测试夹具',project_id=project['id'],project_root=project['path'],task_id=parent['id'],provider='no-provider-local-fixture',model='no-model',account_alias='isolated test; not authenticated')
        c['items'][1]['height']=32
        b=command('create',data={'contract':c});b=command('publish',b,{'confirmed':True});b=command('reserve',b,{'asset_keys':['badge','panel']})
        check('frozen_contract_and_atomic_two_attempts',fingerprint(b['contract'])==b['spec_hash'] and len(b['attempts'])==2)
        h=get('handoff?'+urlencode({'id':b['id']}))['content']
        check('handoff_has_exact_keys_and_no_provider_claim',len(h['items'])==2 and not h['provider_idempotency_guaranteed'] and all(i['active_attempt']['state']=='reserved' for i in h['items']))
        def outcome(batch,index,state,cost):
            return command('outcome',batch,{'attempt_id':batch['attempts'][index]['id'],'state':state,'external_ref':'fixture-original-'+str(index),'evidence':'Synthetic cost value for verifier only, no external billing','charge':{'status':'unknown' if cost is None else 'known','amount':cost},'confirmed':True})
        b=outcome(b,0,'completed','0.10');b=outcome(b,1,'outcome_unknown',None)
        check('unknown_execution_retained',store.get(b['id'])['phase']=='reconcile')
        original=b['attempts'][1]['id'];b=outcome(b,1,'completed',None)
        check('same_original_attempt_reconciled',b['attempts'][1]['id']==original and len(b['attempts'])==2)
        def upload(batch,index,data,name):
            raw={'request_id':str(uuid.uuid4()),'actor':'isolated local upload','batch_id':batch['id'],'expected_version':batch['version'],'attempt_id':batch['attempts'][index]['id'],'spec_hash':batch['spec_hash'],'source_sha256':hashlib.sha256(data).hexdigest(),'name':name}
            headers={'Content-Type':'application/octet-stream','X-CLW-Metadata':quote(json.dumps(raw,ensure_ascii=False))}
            code,result,_=request('upload','POST',data,headers);check('binary_upload_'+name,code==200)
            r=json.loads(result);again_code,again,_=request('upload','POST',data,headers)
            check('same_upload_receipt_'+name,again_code==200 and json.loads(again)['candidate_id']==r['candidate_id'] and json.loads(again)['replayed'])
            return r['batch']
        b=upload(b,0,raster(32),'wrong-size.png');check('mismatch_is_not_approvable',b['candidates'][0]['validation']['status']=='failed')
        b=upload(b,0,raster(metadata=True),'badge.png')
        image=Image.new('RGBA',(32,64),(80,160,220,170));image.putpixel((0,0),(255,100,40,255));exif=Image.Exif();exif[274]=6;raw=BytesIO();image.save(raw,format='PNG',exif=exif)
        b=upload(b,1,raw.getvalue(),'rotated-panel.png')
        check('normalized_orientation_matches_frozen_size',b['candidates'][-1]['width']==64 and b['candidates'][-1]['height']==32 and b['candidates'][-1]['validation']['status']=='passed')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1480,'height':1100});page=ctx.new_page();errors=[];requests=[]
            page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url))
            try:
                page.goto(origin+'/assets.html');page.wait_for_function("() => document.querySelectorAll('.asset-candidate img').length===3 && [...document.querySelectorAll('.asset-candidate img')].every(x=>x.complete&&x.naturalWidth>0)")
                check('all_three_actual_rasters_visible',page.locator('.asset-candidate').count()==3)
                page.screenshot(path=str(out/'candidate-comparison-1480.png'),full_page=True)
                for key in ('badge','panel'):
                    candidates=page.locator('[data-asset-key="'+key+'"] .asset-candidate')
                    candidates.last.get_by_role('button',name='批准',exact=True).click();page.locator('#assetEvidence').fill('这是程序生成的验证光栅；只确认本次流程，不代表商业素材审美或生成质量。');page.locator('#assetConsent').check();page.locator('#assetActionGo').click();page.wait_for_function("() => !document.querySelector('#assetAction').open")
                    page.wait_for_function('(n)=>document.querySelectorAll(".asset-candidate.approved").length===n',arg=1 if key=='badge' else 2)
                check('unknown_charge_still_blocks_export',page.locator('#exportAssetDelivery').is_disabled())
                check('delivery_http_refuses_unknown_charge',request('delivery?'+urlencode({'id':b['id']}))[0]==409)
                b=outcome(store.get(b['id']),1,'completed','0.08')
                parent=tasks.command({'request_id':str(uuid.uuid4()),'actor':'isolated verifier','action':'publish','task_id':parent['id'],'expected_version':parent['version'],'data':{}})['task']
                check('parent_change_blocks_delivery',request('delivery?'+urlencode({'id':b['id']}))[0]==409)
                b=command('confirm_parent',b,{'confirmed':True,'note':'Parent was published; asset requirements unchanged, verified locally'})
                page.locator('#refreshAssets').click();page.wait_for_function("() => document.querySelector('#exportAssetDelivery')?.disabled===false")
                with page.expect_download() as d:page.locator('#exportAssetDelivery').click()
                delivered=Path(d.value.path()).read_bytes();(out/'approved-fixture-delivery.zip').write_bytes(delivered)
                with zipfile.ZipFile(BytesIO(delivered)) as z:
                    m=json.loads(z.read('manifest.json'));check('zip_only_selected_rasters',set(z.namelist())=={'README.txt','manifest.json','candidates/badge.png','candidates/panel.png'})
                    check('every_delivered_hash_matches',all(hashlib.sha256(z.read('candidates/'+x['asset_key']+'.'+x['format'])).hexdigest()==x['sha256'] for x in m['selected_candidates']))
                    with Image.open(BytesIO(z.read('candidates/panel.png'))) as normalized:check('zip_pixels_oriented_and_metadata_removed',normalized.size==(64,32) and not normalized.getexif())
                    check('accounting_declares_fixture_source',m['accounting']['known_total']=='0.18' and all(x['charge']['source']=='operator_report_not_invoice_sync' for x in m['attempts']))
                    check('zip_does_not_claim_production_integration','not_performed' in m['integration'])
                for width in (1480,390):
                    page.set_viewport_size({'width':width,'height':1100});check('responsive_'+str(width),page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'));page.screenshot(path=str(out/f'approved-delivery-{width}.png'),full_page=True)
                check('isolated_browser_no_page_errors',errors==[]);check('isolated_browser_same_origin_only',all(u.startswith(origin+'/') or u.startswith('blob:') for u in requests))
            finally:ctx.close();browser.close()
        reopened=AssetStore(local/'assets.sqlite3',tasks,observer)
        check('reopened_store_keeps_all_three_candidates',reopened.store_id==store.store_id and len(reopened.get(b['id'])['candidates'])==3 and reopened.get(b['id'])['delivery_ready'])
        check('parent_not_automatically_accepted',tasks.get(parent['id'])['status']=='open')
        report.update(status='passed',batch_id=b['id'],parent_task_id=parent['id'],candidate_count=3,selected_count=2,delivery_sha256=hashlib.sha256(delivered).hexdigest())
    except Exception as exc:
        report.update(status='failed',failure_type=type(exc).__name__,failure_message=str(exc)[:1000]);print('FAILED',type(exc).__name__,str(exc)[:1000],flush=True)
    finally:
        if server:server.shutdown();server.server_close()
        if thread:thread.join()
        after=processes();checks.append({'name':'stable_processes_unchanged','passed':before==after})
        same=all((ROOT/f).is_file() and hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in hashes.items());checks.append({'name':'covered_sources_unchanged','passed':same})
        if not all(c['passed'] for c in checks):report['status']='failed'
        report.update(recorded_at=datetime.now(timezone.utc).isoformat(),checks=checks,source_hashes=hashes,sources_unchanged=same,stable_processes_before=before,stable_processes_after=after,candidate_closed=True,real_model_calls=0,credential_files_read=False,production_asset_writes=False,costs_are_test_fixtures=True,manual_visual_review=False)
        (out/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(ROOT/'evidence/WB002-5/latest-delivery.txt').write_text(out.relative_to(ROOT).as_posix()+'\n',encoding='utf-8')
    print('WB0025_DELIVERY',out.relative_to(ROOT).as_posix(),report['status'],len(checks),flush=True)
    return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
