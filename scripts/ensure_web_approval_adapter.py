"""Apply the owned serialized approval adapter without replacing live executors.

Installed releases keep their original files: canonical bytes are substituted
only for the existing CAS reload, then restored. A small per-install payload is
reused by the normal launch/dispatch entry, never by a new resident supervisor.
"""
import argparse, hashlib, json, os, re, sys, time, uuid
from pathlib import Path

def digest(raw):return hashlib.sha256(raw).hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--root',type=Path)
 parser.add_argument('--install-root',type=Path)
 parser.add_argument('--wait-seconds',type=int,default=0)
 args=parser.parse_args()
 install=args.install_root.resolve() if args.install_root else None
 if install:
  active=read(install/'active.json')
  if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[a-f0-9]{8}',str(active.get('build_id',''))):raise RuntimeError('approval_adapter_selected_build_invalid')
  root=install/'versions'/active['build_id'];profile=install/'data/web-host'
 else:
  root=(args.root or Path(__file__).resolve().parents[1]).resolve();profile=root/'.local/web-host'
 sys.path.insert(0,str(root/'scripts'))
 from product_runtime import FileLease
 from web_host_control import AppControl,ControlError
 payload=profile/'approval-adapter';manifest=read(payload/'manifest.json')
 if install and manifest.get('baseBuildId') not in (None,active['build_id']):
  print(json.dumps({'state':'approval_adapter_release_superseded','build':active['build_id'],'modelSends':0}));return
 names=('page-dom.cjs','public-approval.cjs')
 sources={name:(payload/name).read_bytes() for name in names}
 if set(manifest['files'])!=set(names) or any(digest(sources[n])!=manifest['files'][n] for n in names):raise RuntimeError('approval_adapter_payload_changed')
 deadline=time.monotonic()+max(0,min(args.wait_seconds,180))
 while True:
  try:
   # A normal launch creates a fresh port/token/instance descriptor. Do not
   # keep polling the previous closed instance while the new app starts.
   control=AppControl(profile,expected_root=root)
   state=control.state()
   if state.get('task_state_ready') and state.get('connected'):break
  except ControlError:pass
  if time.monotonic()>=deadline:raise RuntimeError('approval_adapter_waiting_for_original_app')
  time.sleep(1)
 target=manifest['files']['page-dom.cjs'];before=state
 if (payload/'pending.json').exists():raise RuntimeError('approval_adapter_query_original_pending_update')
 last=read(payload/'last-result.json') if (payload/'last-result.json').exists() else {}
 if state.get('page_adapter',{}).get('sha256')==target and last.get('approvalSourceSha256')==manifest['files']['public-approval.cjs']:
  print(json.dumps({'state':'approval_adapter_already_current','appPid':state['pid'],'pageAdapter':state['page_adapter'],'modelSends':0}));return
 with FileLease(payload/'update.lock'):
  state=control.state();folder=payload/('operation-'+uuid.uuid4().hex);folder.mkdir()
  pending=payload/'pending.json'
  if pending.exists():raise RuntimeError('approval_adapter_query_original_pending_update')
  original={n:(root/'apps/web-host'/n).read_bytes() for n in names}
  original_stats={n:(root/'apps/web-host'/n).stat() for n in names}
  for n in names:(folder/('original-'+n)).write_bytes(original[n])
  request={'operation_id':uuid.uuid4().hex,'action':'reload-page-adapter','payload':{'expected_page_dom_sha256':target},'expected_identity':{**{k:state[k] for k in ('app_instance_id','root','runtime_generation','selected')},'page_adapter':{k:state['page_adapter'][k] for k in ('sha256','revision')}}}
  intent={'request':request,'root':str(root),'restoreOriginal':bool(install),'originalSha256':{n:digest(original[n]) for n in names},'targetSha256':manifest['files']}
  (folder/'intent.json').write_text(json.dumps(intent,indent=2),encoding='utf-8')
  pending.write_text(json.dumps({'folder':str(folder),'request':request}),encoding='utf-8')
  settled=False;receipt=None;issued=False
  try:
   for n in names:
    file=root/'apps/web-host'/n
    if file.read_bytes()!=original[n]:raise RuntimeError('approval_adapter_original_file_changed')
    if sources[n]!=original[n]:
     temp=file.with_name(file.name+'.approval-'+uuid.uuid4().hex+'.tmp');temp.write_bytes(sources[n]);temp.replace(file)
   issued=True
   try:receipt=control.command(request,wait_seconds=20)
   except ControlError as error:
    receipt=error.original_receipt or {'state':'unknown' if error.accepted is not False else 'rejected','error':str(error),'operation_id':request['operation_id']}
   for _ in range(3):
    if receipt.get('state') in ('completed','rejected','failed'):break
    receipt=control.operation(request['operation_id'],request['expected_identity']['app_instance_id'])
    if receipt.get('state') not in ('completed','rejected','failed'):time.sleep(1)
   (folder/'receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
   settled=receipt.get('state') in ('completed','rejected','failed')
  finally:
   # No restore while an accepted operation still needs its canonical bytes.
   if settled or not issued:
    if install:
     for n in names:
      file=root/'apps/web-host'/n
      if file.read_bytes() not in (sources[n],original[n]):raise RuntimeError('approval_adapter_canonical_changed_during_update')
      if sources[n]!=original[n]:
       temp=file.with_name(file.name+'.restore-'+uuid.uuid4().hex+'.tmp');temp.write_bytes(original[n]);temp.replace(file)
       os.utime(file,ns=(original_stats[n].st_atime_ns,original_stats[n].st_mtime_ns))
      if digest(file.read_bytes())!=digest(original[n]):raise RuntimeError('approval_adapter_base_restore_failed')
    pending.unlink()
  if not settled:raise RuntimeError('approval_adapter_original_receipt_unknown_query_pending')
  if receipt.get('state')!='completed':
   print(json.dumps({'state':'approval_adapter_not_committed','receipt':receipt,'proof':str(folder),'modelSends':0}));raise SystemExit(2)
  after=control.state()
  unchanged=all(before.get(k)==after.get(k) for k in ('pid','app_instance_id','runtime_generation'))
  if not unchanged or after['page_adapter']['sha256']!=target:raise RuntimeError('approval_adapter_loaded_identity_unverified')
  # A normal snapshot reports the version of the actual serialized function,
  # rather than inferring it from a copied file or source test.
  page=next((p for p in after['tasks'] if p.get('renderer_id') and p.get('phase') is None),None)
  verification=None
  if page:
   observation={'operation_id':uuid.uuid4().hex,'action':'task-observation','payload':{'id':page['id']},'expected_identity':{**{k:after[k] for k in ('app_instance_id','root','runtime_generation','selected')},'task':page['identity']}}
   (folder/'verification-intent.json').write_text(json.dumps(observation,indent=2),encoding='utf-8')
   verification=control.command(observation,wait_seconds=20)
   (folder/'verification-receipt.json').write_text(json.dumps(verification,indent=2),encoding='utf-8')
  implementation=(verification or {}).get('result',{}).get('snapshot',{}).get('readiness',{}).get('approvalImplementationVersion')
  result={'state':'approval_adapter_updated','appPid':after['pid'],'runtimePid':after.get('runtime',{}).get('pid'),'pageAdapter':after['page_adapter'],'approvalSourceSha256':manifest['files']['public-approval.cjs'],'approvalImplementationVersion':implementation,'originalOwnersPreserved':unchanged,'installedBaseRestored':bool(install),'proof':str(folder),'modelSends':0,'webGenerationPaused':False}
  (folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');(payload/'last-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result))

if __name__=='__main__':main()
