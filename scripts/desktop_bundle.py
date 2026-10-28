"""Fixed-code portable desktop distribution with explicit reversible shortcuts.
Packaging never adopts a user's live state or alters Desktop/registry/PATH.
Extracted bundles reuse Releases and StateLease; Git is not needed to run them.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
import importlib.metadata
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from product_runtime import (PRODUCT,MANIFEST,COMMIT,ProductError,read_json,json_bytes,digest,
                             atomic_json,verify_release,FileLease)
from workbench_release import Releases,port_busy
from task_worker import explicit_root,linked

ROOT=Path(__file__).resolve().parents[1]
BUNDLE='clw-portable.json'
STARTERS={
    'START_WORKBENCH.cmd':['start','--open'],
    'LINK_DESKTOP_WORKBENCH.cmd':['start','--open','--choose-runner-config'],
    'START_WITH_NOTIFICATIONS.cmd':['start','--open','--enable-workflow-routing'],
    'CHECK_WORKBENCH.cmd':['doctor'],
    'MANAGE_WORKBENCH.cmd':['status'],
}


def launcher(commit):
    if not COMMIT.fullmatch(commit):raise ProductError('exact_bundle_commit_required')
    return ('# Generated fixed portable bootstrap; no network or install side effects.\n'
            'from pathlib import Path\nimport sys\nROOT=Path(__file__).resolve().parent\n'
            f"sys.path.insert(0,str(ROOT/'.local/workbench-releases/payloads/{commit}/scripts'))\n"
            'from desktop_bundle import portable_main\nraise SystemExit(portable_main(ROOT))\n').encode('utf-8')


def package(root,commit,destination):
    root=Path(root).resolve();destination=Path(destination).resolve()
    releases=Releases(root);manifest=releases.prepare(commit);payload,_=releases.release(manifest['source_commit'])
    commit=manifest['source_commit']
    if destination.exists() or not destination.parent.is_dir():raise ProductError('new_explicit_bundle_destination_required')
    if not re.fullmatch(r'[0-9A-Za-z._+-]{1,80}',manifest['version']):raise ProductError('unsafe_bundle_version')
    top='CLW-Control-Center-'+manifest['version'];entries={}
    prefix='.local/workbench-releases/payloads/'+commit+'/'
    for name in [*manifest['files'],MANIFEST]:entries[prefix+name]=(payload/name).read_bytes()
    entries['clw-launcher.py']=launcher(commit)
    for name,arguments in STARTERS.items():
        entries[name]=('@echo off\nsetlocal\ncd /d "%~dp0"\npython -B clw-launcher.py '+' '.join(arguments)+'\nif errorlevel 1 pause\n').encode('utf-8')
    entries['README.txt']=('CLW Control Center '+manifest['version']+'\n\n'
        'Extract into a new directory. Python 3.11+ is required; Pillow enables image imports. No Git, Node or IDE is required for ordinary use.\n'
        'Run CHECK_WORKBENCH.cmd first, then START_WORKBENCH.cmd when ready. This package contains NO accounts, secrets, databases or inherited authorizations.\n'
        'An occupied local port is not permission to close its owner. Do not stop WebCodex, Runner or Tunnels.\n'
        'LINK_DESKTOP_WORKBENCH.cmd opens explicit local connection selection. START_WITH_NOTIFICATIONS.cmd separately asks for native routing opt-in; each task also requires explicit policy.\n'
        'Routing is pinned to an exact native build. Real Host continuation and pilot workloads require their own acceptance; this package is not a guarantee of unattended ChatGPT operation.\n'
        'Create shortcuts only in a chosen folder: python -B clw-launcher.py shortcuts --directory "C:/chosen/folder"\n'
        'Remove only unchanged shortcuts created by this bundle: python -B clw-launcher.py remove-shortcuts\n'
        'Both actions leave application data and native services intact. No startup task, registry or PATH installation is performed.\n'
        'All .local/control-center data belongs to this extracted bundle. Upgrading an existing data directory requires compatible fixed code; never copy a test database over it.\n'
        'Archive hashes verify content consistency, not a publisher digital signature or hostile same-user OS isolation.\n').encode('utf-8')
    record={'format':'clw.portable.v1','product':PRODUCT,'source_commit':commit,'version':manifest['version'],
            'payload_sha256':manifest['payload_sha256'],'files':{k:digest(v) for k,v in entries.items()},
            'credentials_included':False,'user_data_included':False,'native_backend_included':False}
    entries[BUNDLE]=json_bytes(record)
    with destination.open('xb') as stream:
        with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            for name,data in sorted(entries.items()):
                info=zipfile.ZipInfo(top+'/'+name,date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                archive.writestr(info,data)
    return {'archive':str(destination),'sha256':digest(destination.read_bytes()),'bytes':destination.stat().st_size,
            'source_commit':commit,'payload_sha256':manifest['payload_sha256'],'entries':len(entries),'started':False,'installed':False}


def bundle_identity(root):
    root=explicit_root(str(root));metadata=read_json(root/BUNDLE)
    if (metadata.get('format')!='clw.portable.v1' or metadata.get('product')!=PRODUCT or
            not isinstance(metadata.get('source_commit'),str) or not COMMIT.fullmatch(metadata['source_commit'])):
        raise ProductError('unrecognized_portable_bundle')
    files=metadata.get('files')
    if not isinstance(files,dict) or not 5<=len(files)<=600:raise ProductError('invalid_bundle_file_manifest')
    for relative,expected in files.items():
        if not isinstance(relative,str) or relative.startswith(('/', '\\')) or '\\' in relative or ':' in relative or any(p in ('','.','..') for p in relative.split('/')):
            raise ProductError('invalid_bundle_path')
        path=root/relative
        for part in [path,*path.parents]:
            if part==root.parent:break
            if part.exists() and linked(part):raise ProductError('linked_bundle_path')
        if not path.is_file() or path.stat().st_size>2*1024*1024 or digest(path.read_bytes())!=expected:
            raise ProductError('portable_bundle_file_changed')
    code,manifest=Releases(root).release(metadata['source_commit'])
    if manifest['payload_sha256']!=metadata['payload_sha256']:raise ProductError('bundle_payload_identity_changed')
    return root,metadata


def doctor(root):
    root,metadata=bundle_identity(root)
    try:pillow=importlib.metadata.version('Pillow')
    except importlib.metadata.PackageNotFoundError:pillow=None
    return {'product':PRODUCT,'source_commit':metadata['source_commit'],'version':metadata['version'],
            'fixed_payload_verified':True,'python_version':sys.version.split()[0],'python_supported':sys.version_info>=(3,11),
            'pillow':pillow,'image_import_available':pillow is not None,'git_or_ide_required':False,
            'stable_port_occupied':port_busy(18940),'service_started':False,'models_called':False,
            'note':'An occupied port is not a verified CLW instance or permission to stop it.'}


def shortcut_receipt(root):return root/'.local/desktop-shortcuts.json'


def create_shortcuts(root,destination):
    root,metadata=bundle_identity(root);destination=explicit_root(str(destination));receipt=shortcut_receipt(root)
    if receipt.exists():raise ProductError('original_shortcut_receipt_exists_reconcile_first')
    names={'CLW Control Center.lnk':'START_WORKBENCH.cmd','CLW Readiness.lnk':'CHECK_WORKBENCH.cmd'}
    if any((destination/name).exists() for name in names):raise ProductError('existing_shortcut_not_overwritten')
    receipt.parent.mkdir(exist_ok=True)
    with FileLease(root/'.local/desktop-shortcut.lock'):
        if receipt.exists():raise ProductError('original_shortcut_receipt_exists_reconcile_first')
        with tempfile.TemporaryDirectory(prefix='shortcut-',dir=root/'.local') as temporary:
            staging=Path(temporary);plan=staging/'plan.json'
            plan.write_bytes(json_bytes([{'path':str(staging/name),'target':str(root/target),'directory':str(root)} for name,target in names.items()]))
            env=dict(os.environ,CLW_SHORTCUT_PLAN=str(plan))
            code="$ErrorActionPreference='Stop'; $items=Get-Content -LiteralPath $env:CLW_SHORTCUT_PLAN -Raw | ConvertFrom-Json; $shell=New-Object -ComObject WScript.Shell; foreach($item in $items){$link=$shell.CreateShortcut($item.path);$link.TargetPath=$item.target;$link.WorkingDirectory=$item.directory;$link.Save()}"
            result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',code],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=20)
            if result.returncode:raise ProductError('owned_shortcut_creation_failed')
            record={'format':'clw.shortcuts.v1','root':str(root),'destination':str(destination),'status':'publishing','files':{},'source_commit':metadata['source_commit']}
            atomic_json(receipt,record)
            for name in names:
                data=(staging/name).read_bytes();path=destination/name
                with path.open('xb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
                record['files'][name]=digest(data);atomic_json(receipt,record)
            record['status']='installed';atomic_json(receipt,record)
            return {'status':'installed','shortcut_count':len(record['files']),'directory':str(destination),'service_started':False,'registry_modified':False}


def remove_shortcuts(root):
    root=explicit_root(str(root));receipt=shortcut_receipt(root)
    with FileLease(root/'.local/desktop-shortcut.lock'):
        record=read_json(receipt,8192)
        if record.get('format')!='clw.shortcuts.v1' or record.get('root')!=str(root) or record.get('status')!='installed':
            raise ProductError('shortcut_ownership_not_complete_reconcile')
        directory=explicit_root(record['destination'])
        if set(record['files'])!={'CLW Control Center.lnk','CLW Readiness.lnk'}:raise ProductError('unknown_shortcut_manifest')
        for name,expected in record['files'].items():
            path=directory/name
            if linked(path) or not path.is_file() or digest(path.read_bytes())!=expected:raise ProductError('shortcut_changed_no_delete')
        for name in record['files']:(directory/name).unlink()
        record['status']='removed';record['removed_at']=datetime.now(timezone.utc).isoformat();atomic_json(receipt,record)
    return {'status':'removed','application_data_deleted':False,'service_stopped':False}


def portable_main(root):
    parser=argparse.ArgumentParser(description='CLW portable fixed-code workbench, no Git or IDE required')
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('start');p.add_argument('--open',action='store_true');p.add_argument('--port',type=int,default=18940);p.add_argument('--choose-runner-config',action='store_true');p.add_argument('--enable-workflow-routing',action='store_true')
    sub.add_parser('doctor');sub.add_parser('status');sub.add_parser('rollback')
    p=sub.add_parser('shortcuts');p.add_argument('--directory',type=Path,required=True);sub.add_parser('remove-shortcuts')
    args=parser.parse_args()
    try:
        root,metadata=bundle_identity(root);releases=Releases(root)
        if args.command=='doctor':result=doctor(root)
        elif args.command=='status':result=releases.listing()
        elif args.command=='shortcuts':result=create_shortcuts(root,args.directory)
        elif args.command=='remove-shortcuts':result=remove_shortcuts(root)
        elif args.command=='rollback':result=releases.rollback()
        else:
            if sys.version_info<(3,11):raise ProductError('python_3_11_or_newer_required')
            if type(args.port) is not int or not 1<=args.port<=65535:raise ProductError('invalid_port')
            if args.port and port_busy(args.port):raise ProductError('port_occupied_no_existing_service_stopped')
            if releases.selected() is None:releases.select(metadata['source_commit'],None,args.port)
            argv=releases.launch_args('stable',port=args.port)
            if args.open:argv.append('--open')
            if args.choose_runner_config:argv.append('--choose-runner-config')
            if args.enable_workflow_routing:argv.append('--enable-workflow-routing')
            return subprocess.call(argv,cwd=root)
        print(json.dumps(result,ensure_ascii=True,indent=2));return 0
    except (ProductError,OSError,ValueError) as exc:
        print(json.dumps({'success':False,'error':str(exc) if isinstance(exc,ProductError) else type(exc).__name__,'existing_services_stopped':False}));return 1


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--commit',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    try:result=package(ROOT,a.commit,a.out);print(json.dumps(result,ensure_ascii=True,indent=2));return 0
    except (ProductError,OSError,ValueError) as exc:print(json.dumps({'success':False,'error':str(exc) if isinstance(exc,ProductError) else type(exc).__name__}));return 1
if __name__=='__main__':raise SystemExit(main())
