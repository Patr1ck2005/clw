"""Freeze the current Web workspace into an isolated, unsigned Windows candidate.

No dependency install, live-data migration, browser/model start, process stop or
provider change is performed by prepare/install/select/inspect. Launch is a
separate explicit command, using the existing Web workspace supervisor.
"""
from __future__ import annotations
import argparse, ast, hashlib, json, os, re, shutil, stat, subprocess, sys, time, uuid, zipfile
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from product_runtime import FileLease, ProductError, atomic_json

ROOT=Path(__file__).resolve().parents[1]
PRODUCT='clw-web-workspace'
MANIFEST='_clw_web_release.json'
BUILD=re.compile(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[a-f0-9]{8}\Z')
SHA=re.compile(r'[a-f0-9]{64}\Z')
MAX_FILE=320*1024*1024
MAX_TOTAL=2*1024*1024*1024
MAX_FILES=24000
REQUIRED={'package.json','README.md','apps/web-host/package.json','apps/web-host/main.cjs',
 'apps/web-host/index.html','apps/web-host/shell.js','apps/codex-web-bridge/electron-host.cjs',
 'apps/codex-web-bridge/reported-blockers.json',
 'apps/codex-web-bridge/upstream/dist/browser-helper.cjs','scripts/web_host_launcher.py',
 'scripts/serve_harness.py','scripts/harness_goal_control.py','scripts/harness_goal_evidence.py',
 'scripts/web_workspace_release.py','scripts/product_runtime.py',
 'apps/web-host/node_modules/electron/dist/electron.exe',
 'runtime/bun-1.4.0/bun.exe','licenses/bun/LICENSE.md','docs/licenses/tiktoken-1.0.22-LICENSE.txt','NOTICE.md'}
DEFAULT_SCRIPTS={'web_host_launcher','web_host_control','web_companion_control','serve_harness','harness_goal_watch','native_work_admission',
 'read_codex_web_task','webcodex_backend','web_workspace_release','configure_codex_web_bridge','connection_execution_guard',
 'harness_managed_client','harness_team_client','harness_web_client','harness_host_client','harness_rpc',
 'task_resource_worker','task_console','task_routing','workbench_release',
 'native_work_completion','native_work_interruption','native_maintenance','native_tunnel_processes',
 'build_codex_web_overlay','prepare_codex_web_vendor','build_web_public_guides','local_mcp_watch'}
PREVIEW_SCRIPTS={'preview_installer','preview_installation','preview_connections','preview_connection_watch'}
PUBLIC_POLICIES={'config/work-package-policy.json'}
BROWSER_VENDORS=('markdown-it','katex','markdown-it-texmath')
BROWSER_VENDOR_PATH='apps/web-host/assets/vendor'
SKIP_DIRS={'tests','test','__pycache__','.git','.github','.bin','node_modules','examples','coverage'}
RESERVED={'con','prn','aux','nul',*(f'com{i}' for i in range(1,10)),*(f'lpt{i}' for i in range(1,10))}
LAUNCHER=b'@echo off\r\npython -B "%~dp0manager\\web_workspace_release.py" launch --install-root "%~dp0."\r\n'
PRIVATE_RUNTIME={'private_python':'runtime/python/python.exe','powershell':'runtime/powershell/pwsh.exe',
 'native':{'cli':'runtime/native/webcodex.exe','server':'runtime/native/webcodex-server.exe',
           'runner':'runtime/native/webcodex-runner.exe','tunnel':'runtime/native/tunnel-client.exe'}}
BOOTSTRAP_SCRIPTS=frozenset('scripts/'+name+'.py' for name in (
 'preview_installer','web_workspace_release','product_runtime','windows_process_owner','web_host_supervisor_owner'))

def private_runtime_files(files):
    return {n:r for n,r in files.items() if n.startswith(('runtime/python/','runtime/powershell/','runtime/native/'))}

def add_runtime_payload(selected,components,payload):
    """Explicit build input, never a scan of a user's installed application data."""
    if isinstance(payload,(str,Path)):payload=read_json(Path(payload))
    if not isinstance(payload,dict) or set(payload)!={'schema','components'} or payload['schema']!=1 or not isinstance(payload['components'],list):
        raise ProductError('preview_runtime_payload_invalid')
    additions={};inventory=[]
    for component in payload['components']:
        if not isinstance(component,dict) or not all(isinstance(component.get(k),str) and component[k] for k in ('name','version','source','license')) or not isinstance(component.get('files'),dict) or not isinstance(component.get('license_files'),list):
            raise ProductError('preview_runtime_component_invalid')
        names=[]
        for name,source in component['files'].items():
            if not safe_name(name) or not name.startswith(('runtime/python/','runtime/powershell/','runtime/native/','licenses/')) or name in selected or name in additions:
                raise ProductError('preview_runtime_path_invalid')
            source=Path(source)
            if not source.is_absolute():raise ProductError('preview_runtime_source_not_absolute')
            additions[name]=plain(source,source.parent);names.append(name)
        licenses=component['license_files']
        if not licenses or any(not isinstance(n,str) or n not in {*selected,*additions} for n in licenses):raise ProductError('preview_runtime_license_missing')
        runtime_names=[n for n in names if n.startswith('runtime/')]
        component_path=os.path.commonpath(runtime_names or names).replace('\\','/')
        if len(runtime_names or names)==1:component_path=Path(component_path).parent.as_posix()
        inventory.append({k:v for k,v in component.items() if k!='files'}|{'path':component_path,'files':sorted(names)})
    required={PRIVATE_RUNTIME['private_python'],PRIVATE_RUNTIME['powershell'],*PRIVATE_RUNTIME['native'].values()}
    if not required.issubset(additions):raise ProductError('preview_core_runtime_missing')
    selected.update(additions);components.extend(inventory)

def utc():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def canonical(value):return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode('utf8')
def sha(data):return hashlib.sha256(data).hexdigest()
def linked(path):
    try:return path.is_symlink() or bool(getattr(path.lstat(),'st_file_attributes',0)&0x400)
    except FileNotFoundError:return False
def safe_name(name):
    if not isinstance(name,str) or len(name)>240 or '\\' in name or ':' in name:return False
    parts=name.split('/')
    return bool(parts) and all(re.fullmatch(r'[A-Za-z0-9_@.+-]+',p) and p not in ('.','..') and
      not p.endswith(('.', ' ')) and p.split('.')[0].lower() not in RESERVED for p in parts)
def plain(path,base):
    path=Path(path);base=Path(base).resolve()
    try:relative=path.absolute().relative_to(base)
    except ValueError:raise ProductError('candidate_path_outside_root') from None
    current=base
    for part in relative.parts:
        current=current/part
        if linked(current):raise ProductError('candidate_source_link')
    if not current.is_file():raise ProductError('candidate_source_missing')
    return current
def read_json(path,maximum=8*1024*1024):
    if linked(path) or not path.is_file() or path.stat().st_size>maximum:raise ProductError('candidate_metadata_invalid')
    try:return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError,ValueError,UnicodeError):raise ProductError('candidate_metadata_invalid') from None
def file_hash(path):
    h=hashlib.sha256();size=0
    with path.open('rb') as f:
        while chunk:=f.read(1024*1024):h.update(chunk);size+=len(chunk)
    return {'sha256':h.hexdigest(),'bytes':size}
def collect_tree(base,root,selected,*,extensions=None):
    if linked(base) or not base.is_dir():raise ProductError('candidate_directory_missing_or_linked')
    for folder,dirs,files in os.walk(base,followlinks=False):
        for name in dirs:
            if linked(Path(folder)/name):raise ProductError('candidate_source_link')
        dirs[:]=sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            path=Path(folder)/name
            if extensions is None or path.suffix.lower() in extensions:
                key=path.relative_to(root).as_posix()
                if not safe_name(key):raise ProductError('candidate_source_name_invalid')
                selected[key]=plain(path,root)

def local_modules(root,seeds):
    """AST closure includes conditional imports and literal dynamic imports."""
    scripts=root/'scripts';known={p.stem:p for p in scripts.glob('*.py')};todo=list(seeds);seen=set()
    while todo:
        name=todo.pop()
        if name in seen:continue
        if name not in known:raise ProductError('candidate_python_entry_missing:'+name)
        seen.add(name);tree=ast.parse(plain(known[name],root).read_text(encoding='utf-8-sig'))
        names=[]
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):names.extend(n.name.split('.')[0] for n in node.names)
            elif isinstance(node,ast.ImportFrom) and node.module:names.append(node.module.split('.')[0])
            elif isinstance(node,ast.Call) and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str):
                function=node.func
                if (isinstance(function,ast.Name) and function.id=='__import__' or
                    isinstance(function,ast.Attribute) and function.attr=='import_module'):
                    names.append(node.args[0].value.split('.')[0])
        todo.extend(n for n in names if n in known and n not in seen)
    return sorted(known[n] for n in seen)

def production_packages(root,entry,selected,components):
    """Installed dependency closure; dev packages and arbitrary directories absent."""
    entry=Path(entry);package=read_json(entry/'package.json');base=entry/'node_modules'
    todo=list(package.get('dependencies',{}));seen=set()
    while todo:
        name=todo.pop()
        if name in seen:continue
        if not re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+',name):raise ProductError('candidate_dependency_name_invalid')
        directory=base/name;meta=read_json(plain(directory/'package.json',root))
        if meta.get('name')!=name or not isinstance(meta.get('version'),str):raise ProductError('candidate_dependency_identity_invalid')
        seen.add(name);collect_tree(directory,root,selected)
        prefix=directory.relative_to(root).as_posix()+'/'
        notices=[p for p in selected if p.startswith(prefix) and Path(p).name.lower().startswith(('license','copying','notice'))]
        components.append({'name':name,'version':meta['version'],'license':meta.get('license','provider_metadata_unspecified'),
          'path':directory.relative_to(root).as_posix(),'license_files':sorted(notices)})
        todo.extend(meta.get('dependencies',{}));todo.extend(n for n in meta.get('optionalDependencies',{}) if (base/n/'package.json').is_file())
        todo.extend(n for n in meta.get('peerDependencies',{}) if (base/n/'package.json').is_file())
    return seen

def browser_vendors(root,selected,components):
    """UPSTREAM is the sole provider inventory; only its exact offline files ship."""
    root=Path(root).resolve();container=root/BROWSER_VENDOR_PATH
    if linked(container) or not container.is_dir():raise ProductError('candidate_browser_vendor_directory_invalid')
    children=list(container.iterdir())
    if {p.name for p in children}!=set(BROWSER_VENDORS) or any(linked(p) or not p.is_dir() for p in children):
        raise ProductError('candidate_browser_vendor_directory_invalid')
    for name in BROWSER_VENDORS:
        base=container/name;prefix=BROWSER_VENDOR_PATH+'/'+name+'/'
        metadata_path=plain(base/'UPSTREAM.json',root);metadata_entry=file_hash(metadata_path);meta=read_json(metadata_path)
        if not isinstance(meta,dict) or meta.get('name')!=name or not isinstance(meta.get('version'),str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?',meta['version']) or meta.get('license')!='MIT':
            raise ProductError('candidate_browser_vendor_identity_invalid')
        if meta.get('source')!='https://registry.npmjs.org/'+name+'/-/'+name+'-'+meta['version']+'.tgz':
            raise ProductError('candidate_browser_vendor_source_invalid')
        inventory=meta.get('files')
        if not isinstance(inventory,dict) or not 0<len(inventory)<=MAX_FILES or 'LICENSE' not in inventory:
            raise ProductError('candidate_browser_vendor_license_or_files_invalid')
        seen=set()
        for relative,entry in inventory.items():
            if not safe_name(relative) or relative=='UPSTREAM.json' or relative.casefold() in seen or not isinstance(entry,dict) or set(entry)!={'sha256','bytes'} or not SHA.fullmatch(str(entry['sha256'])) or type(entry['bytes']) is not int or not 0<entry['bytes']<=MAX_FILE:
                raise ProductError('candidate_browser_vendor_file_entry_invalid')
            seen.add(relative.casefold())
            if file_hash(plain(base/relative,root))!=entry:raise ProductError('candidate_browser_vendor_file_mismatch')
        actual=set()
        for folder,dirs,names in os.walk(base,followlinks=False):
            if any(linked(Path(folder)/d) for d in dirs):raise ProductError('candidate_source_link')
            for filename in names:
                source=plain(Path(folder)/filename,root);actual.add(source.relative_to(base).as_posix())
        if actual!={*inventory,'UPSTREAM.json'}:raise ProductError('candidate_browser_vendor_files_changed')
        expected={prefix+n for n in actual};existing={n for n in selected if n.startswith(prefix)}
        if existing and existing!=expected:raise ProductError('candidate_browser_vendor_selection_invalid')
        for relative in sorted(actual):
            key=prefix+relative;source=plain(base/relative,root)
            if key in selected and Path(selected[key]).absolute()!=source.absolute():raise ProductError('candidate_browser_vendor_source_invalid')
            selected[key]=source
        if file_hash(metadata_path)!=metadata_entry:raise ProductError('candidate_browser_vendor_metadata_changed')
        components.append({'name':meta['name'],'version':meta['version'],'license':meta['license'],
          'path':BROWSER_VENDOR_PATH+'/'+name,'license_files':[prefix+'LICENSE'],'source':meta['source'],
          'metadata_file':prefix+'UPSTREAM.json','metadata_sha256':metadata_entry['sha256'],'metadata_bytes':metadata_entry['bytes'],
          'files':sorted(prefix+n for n in inventory)})

def verify_browser_inventory(root,selected,components):
    if not any(n.startswith(BROWSER_VENDOR_PATH+'/') for n in selected):return
    checked={};inventory=[];browser_vendors(root,checked,inventory)
    chosen={n:p for n,p in selected.items() if n.startswith(BROWSER_VENDOR_PATH+'/')}
    registered=[c for c in components if c.get('path') in {BROWSER_VENDOR_PATH+'/'+n for n in BROWSER_VENDORS}]
    if chosen!=checked or sorted(registered,key=lambda c:c['path'])!=sorted(inventory,key=lambda c:c['path']):
        raise ProductError('candidate_browser_vendor_inventory_changed')

def verify_local_code_references(root,selected):
    """Check literal project module references, including runtime JSON rules."""
    root=Path(root).resolve();missing=[]
    pattern=re.compile(r'''(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*\(\s*)['"](\.[^'"]+)['"]''')
    for name,path in selected.items():
        if '/node_modules/' in name or Path(name).suffix not in ('.cjs','.js','.mjs','.ts'):continue
        for match in pattern.finditer(path.read_text(encoding='utf-8-sig')):
            reference=match[1]
            if '${' in reference:continue
            absolute=Path(os.path.normpath(path.parent/reference))
            candidates=[absolute,*[Path(str(absolute)+suffix) for suffix in ['.js','.cjs','.mjs','.json','.ts']],
              absolute/'index.js',absolute/'index.ts']
            if absolute.suffix=='.js':candidates.append(absolute.with_suffix('.ts'))
            keys=[]
            for candidate in candidates:
                try:keys.append(candidate.relative_to(root).as_posix())
                except ValueError:pass
            if not any(key in selected for key in keys):missing.append(name+' -> '+reference)
    if missing:raise ProductError('candidate_local_module_missing:'+missing[0])

def native_source_materials(root,selected):
    """Verify native materials and select the current source ZIP and patches."""
    prefix='vendor/native-runtime/';base=Path(root)/prefix
    manifest=read_json(plain(base/'manifest.json',root))
    if not isinstance(manifest,dict) or manifest.get('schema')!=1 or not isinstance(manifest.get('files'),list):
        raise ProductError('candidate_native_source_manifest_invalid')
    entries=manifest['files'];head=manifest.get('source_head')
    if not isinstance(head,str) or not re.fullmatch(r'[a-f0-9]{40}',head):
        raise ProductError('candidate_native_source_manifest_invalid')
    additions={};seen=set();current_archives=[]
    for entry in entries:
        if not isinstance(entry,dict) or not safe_name(entry.get('path')) or entry['path'].casefold() in seen:
            raise ProductError('candidate_native_source_entry_invalid')
        name=entry['path'];seen.add(name.casefold())
        archive=re.fullmatch(r'source-git-[a-f0-9]{12,40}\.zip',name)
        patch=re.fullmatch(r'patches/[A-Za-z0-9_@.+-]+\.patch',name)
        if not archive and not patch and name not in {'README.md','LICENSE-APACHE-2.0','.gitattributes'}:
            raise ProductError('candidate_native_source_path_invalid')
        if not SHA.fullmatch(str(entry.get('sha256'))) or type(entry.get('bytes')) is not int or not 0<=entry['bytes']<=MAX_FILE:
            raise ProductError('candidate_native_source_entry_invalid')
        source=plain(base/name,root)
        if file_hash(source)!={'sha256':entry['sha256'],'bytes':entry['bytes']}:
            raise ProductError('candidate_native_source_file_mismatch')
        if archive and head.startswith(name.removeprefix('source-git-').removesuffix('.zip')):
            current_archives.append(name);additions[prefix+name]=source
        elif patch:additions[prefix+name]=source
    if len(current_archives)!=1:raise ProductError('candidate_native_source_current_archive_invalid')
    selected.update(additions)

def audit_plan(root,bun_notice,*,preview=False):
    root=Path(root).resolve();selected={};components=[]
    def add(name):selected[name]=plain(root/name,root)
    for name in ['LICENSE','package.json','apps/web-host/package.json','apps/web-host/package-lock.json',
      'docs/WEB_WORKSPACE_CANDIDATE.md','docs/harness/APP_CONTROL.md',
      'apps/codex-web-bridge/upstream/package.json','apps/codex-web-bridge/upstream/bun.lock',
      'apps/codex-web-bridge/upstream/LICENSE','apps/codex-web-bridge/upstream/UPSTREAM.json',
      'apps/codex-web-bridge/upstream/dist/browser-helper.cjs',
      'apps/web-host/vendor/codex-chatgpt-web/LICENSE','apps/web-host/vendor/codex-chatgpt-web/UPSTREAM.json',
      'apps/codex-web-bridge/reported-blockers.json',
      'apps/codex-web-bridge/README.md',
      'docs/licenses/tiktoken-1.0.22-LICENSE.txt',
      'apps/codex-web-bridge/vendor-overlays/manifest.json',
      'apps/codex-web-bridge/vendor-overlays/clw.patch',
      'apps/codex-web-bridge/vendor-overlays/post-backport/manifest.json',
      'apps/codex-web-bridge/vendor-overlays/post-backport/clw.patch',
      'apps/codex-web-bridge/vendor-backports/6.1.2/manifest.json',
      'apps/codex-web-bridge/vendor-backports/6.1.2/clw.patch',
      'apps/web-host/vendor/codex-chatgpt-web/launcher/electron/turn-suspension.cjs',
      *PUBLIC_POLICIES]:add(name)
    if preview:
        for name in ['docs/FREE_PREVIEW_TERMS.md','docs/PRIVACY.md',
                     'docs/PREVIEW_LIMITATIONS.md','docs/PREVIEW_FEEDBACK.md',
                     'vendor/native-runtime/LICENSE-APACHE-2.0','vendor/native-runtime/README.md',
                     'vendor/native-runtime/manifest.json']:
            add(name)
        native_source_materials(root,selected)
    selected['README.md']=plain(root/'docs/WEB_WORKSPACE_START.md',root)
    for name in ['MANAGED_WEB.md','HOST_RECEIVER.md','WEB_RECEIVER.md']:
        selected['docs/harness/'+name]=plain(root/'docs/product-receivers'/name,root)
    for folder,extensions in [('apps/web-host',{'.cjs','.js','.html','.css'}),('apps/codex-web-bridge',{'.cjs','.ts'})]:
        for path in sorted((root/folder).iterdir()):
            if path.is_file() and path.suffix in extensions:add(path.relative_to(root).as_posix())
    collect_tree(root/'apps/web-host/assets',root,selected)
    collect_tree(root/'apps/web-recovery-companion',root,selected,extensions={'.js','.html','.css','.json','.md'})
    browser_vendors(root,selected,components)
    collect_tree(root/'apps/codex-web-bridge/upstream/src',root,selected,extensions={'.ts','.js','.json','.txt','.md'})
    collect_tree(root/'apps/codex-web-bridge/upstream/launcher/electron',root,selected,extensions={'.cjs','.json'})
    # The private browser service imports the legacy harness HTTP assets. Its
    # auxiliary panel is retained; the release entry always uses the Web host.
    collect_tree(root/'apps/control-center',root,selected,extensions={'.html','.mjs','.js','.css'})
    for path in local_modules(root,DEFAULT_SCRIPTS|(PREVIEW_SCRIPTS if preview else set())):add(path.relative_to(root).as_posix())
    for name in ['start_codex_web.ps1','start_local_codex.ps1','start_local_mcp_a.ps1','start_local_mcp_b.ps1',
                 'recover_local_mcp.ps1','install_local_mcp_startup.ps1','local_mcp_credentials.ps1']:
        add('scripts/'+name)
    # Explicit operator helper for the application's original guarded exit.
    # No arbitrary script directory or per-installation state is shipped.
    add('scripts/quit_web_workspace_for_maintenance.cjs')
    for name in ['apps/web-host','apps/codex-web-bridge/upstream']:
        production_packages(root,root/name,selected,components)
    for component in components:
        if component['name']=='tiktoken':
            if component['version']!='1.0.22':raise ProductError('candidate_tiktoken_notice_version_changed')
            component['license_files'].append('docs/licenses/tiktoken-1.0.22-LICENSE.txt')
            component['official_license_source']='https://github.com/dqbd/tiktoken/blob/4c8b748e07992c00386f3180af5c574b27b65139/LICENSE'
    dist=root/'apps/web-host/node_modules/electron/dist'
    collect_tree(dist,root,selected)
    electron=read_json(plain(dist.parent/'package.json',root))
    if (dist/'version').read_text().strip()!=electron['version']:raise ProductError('candidate_electron_version_mismatch')
    components.append({'name':'electron','version':electron['version'],'license':electron.get('license','MIT'),
      'path':dist.relative_to(root).as_posix(),'license_files':[(dist/n).relative_to(root).as_posix() for n in ['LICENSE','LICENSES.chromium.html']]})
    upstream=read_json(root/'apps/codex-web-bridge/upstream/package.json')
    components.append({'name':'codex-chatgpt-web','version':upstream['version'],'license':upstream['license'],
      'path':'apps/codex-web-bridge/upstream','license_files':['apps/codex-web-bridge/upstream/LICENSE']})
    bun=plain(root/'.local/runtimes/bun-1.4.0/bun.exe',root)
    source=read_json(root/'.local/runtimes/bun-1.4.0/SOURCE.json')
    if source.get('package')!='@oven/bun-windows-x64@1.4.0' or file_hash(bun)['sha256']!=source.get('binary_sha256'):
        raise ProductError('candidate_bun_identity_invalid')
    selected['runtime/bun-1.4.0/bun.exe']=bun
    bun_notice=Path(bun_notice).resolve()
    if linked(bun_notice) or not bun_notice.is_file() or bun_notice.stat().st_size>2*1024*1024:raise ProductError('candidate_bun_notice_required')
    selected['licenses/bun/LICENSE.md']=bun_notice
    components.append({'name':'bun','version':'1.4.0','license':'MIT with bundled third-party obligations',
      'path':'runtime/bun-1.4.0','license_files':['licenses/bun/LICENSE.md'],
      'official_license_source':'https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md',
      'review_required':'Bundled JavaScriptCore/WebKit LGPL and other provider notices/relink obligations before external distribution'})
    verify_local_code_references(root,selected)
    return selected,components

def notice(components,*,preview=False):
    if preview:
        lines=['# CLW Free Preview notices','',
         'CLW-owned code is distributed under the MIT License. Copyright (c) 2026 CLW contributors. See LICENSE and docs/FREE_PREVIEW_TERMS.md.',
         'This Windows x64 preview is free of charge and unsigned. Third-party components retain their own licenses and rights.',
         'Python, PowerShell, Electron, Bun, the native backend/Runner, and tunnel-client are included. No user accounts, browser profiles, credentials, connection settings, or private data are included.',
         'Bun bundles JavaScriptCore/WebKit and other libraries. Its upstream notices are preserved; any applicable LGPL modification, source, replacement, or relinking obligations remain with the distributor.', '',
         'The preview installer includes corresponding third-party build-source snapshots and build/relink instructions. Rerun the same installer and select the optional source-materials task to extract third-party-sources/BUILD-AND-RELINK.md. These materials do not assert a successful rebuild or binary equivalence.', '',
         '| Shipped component | Version | Provider license | Included notices |','|---|---|---|---|']
    else:
        lines=['# CLW Web workspace candidate notices','',
     'Unsigned candidate. CLW-owned code is distributed under the MIT License. Copyright (c) 2026 CLW contributors. See LICENSE. Third-party components retain their own licenses and rights.',
     'Existing provider files and package metadata are preserved. This inventory does not assert that all downstream distribution obligations have been discharged.',
     'Bun bundles JavaScriptCore/WebKit under LGPL and other libraries; review the applicable notices and relink/object obligations before external distribution.',
     'Python 3.11+ is an external prerequisite, not bundled. Codex CLI, VPN and Local-MCP/backend services are external prerequisites, not bundled or configured. Pillow is optional for legacy image ingestion.', '',
     '| Shipped component | Version | Provider license | Included notices |','|---|---|---|---|']
    for c in sorted(components,key=lambda x:(x['path'],x['name'])):
        lines.append('| '+c['name']+' | '+c['version']+' | '+str(c['license']).replace('|','/')+' | '+', '.join(c['license_files'])+' |')
    offline=[c for c in components if c.get('metadata_file')]
    if offline:
        lines.extend(['','Offline browser provider inventories:'])
        for c in sorted(offline,key=lambda x:x['path']):
            lines.append('- '+c['name']+': '+c['metadata_file']+'; '+str(len(c['files']))+' selected files; SHA256 '+c['metadata_sha256']+'; '+str(c['metadata_bytes'])+' bytes.')
    lines.extend(['','No accounts, browser profiles, sessions, SQLite ledgers, connection configuration, environment files, per-user authorizations or secrets are included. Only the public work-package policy is included.',''])
    return '\n'.join(lines).encode('utf8')

def validate_manifest(manifest):
    if not isinstance(manifest,dict) or manifest.get('schema')!=1 or manifest.get('product')!=PRODUCT or not BUILD.fullmatch(str(manifest.get('build_id',''))):
        raise ProductError('candidate_manifest_invalid')
    files=manifest.get('files')
    if not isinstance(files,dict) or not REQUIRED.issubset(files) or not 0<len(files)<=MAX_FILES:raise ProductError('candidate_files_invalid')
    total=0;seen=set()
    for name,row in files.items():
        if not safe_name(name) or name.casefold() in seen or not isinstance(row,dict) or set(row)!={'sha256','bytes'} or not SHA.fullmatch(str(row['sha256'])) or type(row['bytes']) is not int or not 0<=row['bytes']<=MAX_FILE:
            raise ProductError('candidate_file_entry_invalid')
        parts=name.casefold().split('/')
        if (any(p in ('.local','.git','__pycache__','secrets','accounts') for p in parts) or
          any(p.startswith('.env') for p in parts) or
          Path(name).suffix.lower() in ('.db','.sqlite','.sqlite3','.env','.key','.pem','.db-wal','.db-shm','.db-journal','.sqlite-wal','.sqlite-shm','.sqlite-journal','.sqlite3-wal','.sqlite3-shm','.sqlite3-journal') or
          parts[0] in ('data','evidence','checkpoints') or name.casefold() in ('current.md','dev.md') or
          name.casefold().startswith('config/') and name.casefold() not in {p.casefold() for p in PUBLIC_POLICIES}):
            raise ProductError('candidate_private_payload_forbidden')
        seen.add(name.casefold());total+=row['bytes']
    if total>MAX_TOTAL or manifest.get('payload_sha256')!=sha(canonical(files)):raise ProductError('candidate_payload_digest_invalid')
    if type(manifest.get('data_epoch')) is not int or manifest['data_epoch']<1 or manifest.get('platform')!='windows-x64':raise ProductError('candidate_platform_or_data_epoch_invalid')
    expected={'bun_sha256':files['runtime/bun-1.4.0/bun.exe']['sha256'],
      'electron_dist_sha256':sha(canonical({n:r for n,r in files.items() if n.startswith('apps/web-host/node_modules/electron/dist/')})),
      'python_minimum':'3.11'}
    private=private_runtime_files(files)
    if private:
        required={PRIVATE_RUNTIME['private_python'],PRIVATE_RUNTIME['powershell'],*PRIVATE_RUNTIME['native'].values()}
        if not required.issubset(files):raise ProductError('preview_core_runtime_missing')
        expected.update(PRIVATE_RUNTIME);expected['private_runtime_sha256']=sha(canonical(private))
    if manifest.get('runtime_contract')!=expected:raise ProductError('candidate_runtime_contract_invalid')
    return manifest

def prepare(root,output,bun_notice,*,plan=None,source_commit=None,runtime_payload=None,notice_file=None,staging=None):
    root=Path(root).resolve();output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    selected,components=plan if plan is not None else audit_plan(root,bun_notice,preview=runtime_payload is not None)
    selected=dict(selected);components=list(components)
    if runtime_payload is not None:add_runtime_payload(selected,components,runtime_payload)
    if not REQUIRED.difference({'NOTICE.md'}).issubset(selected):raise ProductError('candidate_required_source_missing')
    verify_browser_inventory(root,selected,components)
    # Active staging may use SSD storage while the immutable archive goes to
    # external storage. The same freeze and archive verification still applies.
    stage_home=no_link_directory(staging).resolve() if staging is not None else output
    stage_home.mkdir(parents=True,exist_ok=True)
    stage=stage_home/('preparing-'+uuid.uuid4().hex);stage.mkdir()
    files={};fingerprints={}
    for name,source in sorted(selected.items()):
        if not safe_name(name):raise ProductError('candidate_source_name_invalid')
        source=Path(source);before=source.stat()
        if linked(source) or not source.is_file() or before.st_size>MAX_FILE:raise ProductError('candidate_source_invalid')
        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        after=source.stat();entry=file_hash(target)
        if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns) or file_hash(source)!=entry:
            raise ProductError('candidate_source_changed_during_freeze')
        files[name]=entry;fingerprints[name]=(source,entry)
    verify_browser_inventory(stage,{name:stage/name for name in selected},components)
    notice_bytes=Path(notice_file).read_bytes() if notice_file is not None else notice(components,preview=runtime_payload is not None)
    (stage/'NOTICE.md').write_bytes(notice_bytes);files['NOTICE.md']=file_hash(stage/'NOTICE.md')
    package=read_json(stage/'package.json');web=read_json(stage/'apps/web-host/package.json')
    if package['version']!=web['version']:raise ProductError('candidate_product_versions_differ')
    payload=sha(canonical(files));build=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+payload[:12]+'-'+uuid.uuid4().hex[:8]
    if source_commit is None:
        result=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],capture_output=True,text=True,timeout=15,check=True)
        source_commit=result.stdout.strip()
    manifest={'schema':1,'product':PRODUCT,'build_id':build,'version':package['version'],
      'data_epoch':package.get('clw_data_epoch',1),'platform':'windows-x64','source_commit':source_commit,
      'source_kind':'frozen_current_worktree','created_at':utc(),'files':files,'payload_sha256':payload,
      'runtime_contract':{'bun_sha256':files['runtime/bun-1.4.0/bun.exe']['sha256'],
       'electron_dist_sha256':sha(canonical({n:r for n,r in files.items() if n.startswith('apps/web-host/node_modules/electron/dist/')})),
       'python_minimum':'3.11'},'components':components,'license_state':'candidate_notice_review_required',
      'model_sends':0,'user_data_included':False,'project_distribution_license':'MIT',
      'distribution':'open-source-unsigned-candidate',
      'documentation_sources':{name:source.relative_to(root).as_posix() for name,source in selected.items()
        if name=='README.md' or name.startswith('docs/harness/') if source.is_relative_to(root) and source.relative_to(root).as_posix()!=name}}
    if runtime_payload is not None:
        manifest['runtime_contract'].update(PRIVATE_RUNTIME)
        manifest['runtime_contract']['private_runtime_sha256']=sha(canonical(private_runtime_files(files)))
        manifest['distribution']='free-open-source-unsigned-preview'
        manifest['license_state']='preview_notices_included_review_required'
    validate_manifest(manifest);atomic_json(stage/MANIFEST,manifest)
    archive=output/(build+'.zip')
    with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for name in [*sorted(files),MANIFEST]:z.write(stage/name,name)
    for source,entry in fingerprints.values():
        if linked(source) or file_hash(source)!=entry:raise ProductError('candidate_source_changed_during_freeze')
    verified=verify_archive(archive)
    report={'state':'candidate_prepared','build_id':build,'archive':str(archive),**file_hash(archive),
      'files':len(files),'payload_bytes':sum(row['bytes'] for row in files.values()),'payload_sha256':payload,
      'source_kind':verified['source_kind'],'model_sends':0,'live_data_accessed':False,'license_state':manifest['license_state']}
    atomic_json(output/(build+'.json'),report);return report

def archive_members(z,manifest):
    infos=z.infolist();names=[i.filename for i in infos]
    if len(names)!=len(set(n.casefold() for n in names)) or set(names)!={*manifest['files'],MANIFEST}:raise ProductError('candidate_archive_members_invalid')
    for info in infos:
        mode=info.external_attr>>16
        if not safe_name(info.filename) or info.is_dir() or stat.S_ISLNK(mode) or info.flag_bits&1 or info.file_size>MAX_FILE:
            raise ProductError('candidate_archive_member_invalid')
    return infos
def verify_archive(archive,expected_sha256=None):
    archive=Path(archive)
    if linked(archive) or not archive.is_file():raise ProductError('candidate_archive_missing')
    if expected_sha256 is not None and (not SHA.fullmatch(expected_sha256) or file_hash(archive)['sha256']!=expected_sha256):raise ProductError('candidate_archive_sha_mismatch')
    try:
        with zipfile.ZipFile(archive) as z:
            info=z.getinfo(MANIFEST)
            if info.file_size>8*1024*1024:raise ProductError('candidate_manifest_too_large')
            manifest=validate_manifest(json.loads(z.read(info)))
            archive_members(z,manifest)
            for name,entry in manifest['files'].items():
                h=hashlib.sha256();size=0
                with z.open(name) as f:
                    while chunk:=f.read(1024*1024):h.update(chunk);size+=len(chunk)
                if {'sha256':h.hexdigest(),'bytes':size}!=entry:raise ProductError('candidate_archive_file_mismatch')
            return manifest
    except (zipfile.BadZipFile,KeyError,ValueError,UnicodeError) as error:
        if isinstance(error,ProductError):raise
        raise ProductError('candidate_archive_invalid') from None

def no_link_directory(path):
    path=Path(path).absolute()
    for parent in [path,*path.parents]:
        if linked(parent):raise ProductError('candidate_install_directory_link')
    return path
def junction(link,target):
    if os.name!='nt':os.symlink(target,link,target_is_directory=True);return
    def quote(value):return "'"+str(value).replace("'","''")+"'"
    command='New-Item -ItemType Junction -Path '+quote(link)+' -Target '+quote(target)+' | Out-Null'
    windows=Path(os.environ.get('SystemRoot',''))
    shell=windows/'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not windows.is_absolute() or not shell.is_file():raise ProductError('candidate_windows_powershell_unavailable')
    subprocess.run([str(shell),'-NoProfile','-NonInteractive','-Command',command],
      capture_output=True,timeout=15,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    for delay in (0,.025,.075):
        if delay:time.sleep(delay)
        if linked(link) and link.resolve()==target.resolve():return
    raise ProductError('candidate_data_junction_failed')

def publish_directory(source,target,*,sleep=time.sleep,replace=None):
    """Retry only a proven unperformed rename of this exact new directory."""
    source=Path(source);target=Path(target);replace=replace or os.replace
    no_link_directory(source);no_link_directory(target)
    before=source.stat();identity=(before.st_dev,before.st_ino)
    delays=(.1,.2,.4,.8,1.5,2,4,8,12)
    for attempt in range(len(delays)+1):
        if target.exists():
            stat=target.stat()
            if not source.exists() and (stat.st_dev,stat.st_ino)==identity:return
            raise ProductError('candidate_publish_target_changed')
        current=source.stat()
        if (current.st_dev,current.st_ino)!=identity:raise ProductError('candidate_publish_source_changed')
        try:replace(source,target)
        except OSError as error:
            if not source.exists() and target.exists():
                stat=target.stat()
                if (stat.st_dev,stat.st_ino)==identity:return
            if attempt==len(delays) or getattr(error,'winerror',None) not in (5,32,33) or target.exists():raise
            current=source.stat()
            if (current.st_dev,current.st_ino)!=identity:raise ProductError('candidate_publish_source_changed') from None
            sleep(delays[attempt]);continue
        current=target.stat()
        if (current.st_dev,current.st_ino)!=identity:raise ProductError('candidate_publish_target_changed')
        return
def verify_version(code,data=None):
    no_link_directory(code)
    local=code/'.local'
    if data is not None:
        no_link_directory(data)
        if not linked(local) or local.resolve()!=data.resolve():raise ProductError('candidate_data_link_identity_invalid')
    elif local.exists() or linked(local):raise ProductError('candidate_unselected_data_link')
    manifest=validate_manifest(read_json(code/MANIFEST));seen=set()
    for folder,dirs,names in os.walk(code,followlinks=False):
        for directory in list(dirs):
            target=Path(folder)/directory
            if target==code/'.local':
                if data is None or not linked(target) or target.resolve()!=data.resolve():raise ProductError('candidate_data_link_identity_invalid')
                dirs.remove(directory)
            elif linked(target):raise ProductError('candidate_version_link')
        for name in names:
            target=Path(folder)/name;relative=target.relative_to(code).as_posix()
            if linked(target):raise ProductError('candidate_version_link')
            seen.add(relative)
    if seen!={*manifest['files'],MANIFEST}:raise ProductError('candidate_version_files_changed')
    for name,entry in manifest['files'].items():
        if file_hash(plain(code/name,code))!=entry:raise ProductError('candidate_version_file_changed')
    return manifest

def version_process(row,prefix):
    command=str(row.get('CommandLine') or '').replace('\\','/').casefold()
    image=str(row.get('ExecutablePath') or '').replace('\\','/').casefold()
    return prefix in command or image.startswith(prefix)

def process_rows(install=None,*,sleep=time.sleep,include_native=False):
    if os.name!='nt':
        rows=[]
        for proc in Path('/proc').glob('[0-9]*'):
            try:rows.append({'ProcessId':int(proc.name),'CommandLine':(proc/'cmdline').read_bytes().decode(errors='replace').replace('\0',' ')})
            except OSError:pass
        return rows
    try:
        from windows_process_owner import process_inventory,OwnershipUnavailable
        prefix=str(Path(install)/'versions').replace('\\','/').casefold()+'/' if install is not None else None
        def candidate(row):
            # Classification requires complete native identity. An unreadable
            # path/argv must not turn a possible owner into a foreign process.
            if any(not isinstance(row.get(key),str) or not row[key] for key in ('CommandLine','ExecutablePath')):
                raise OwnershipUnavailable()
            return version_process(row,prefix)
        for attempt in range(3):
            try:
                options={'candidate_filter':candidate if prefix is not None else None}
                if include_native:
                    from windows_process_owner import SUPPORTED_TARGET_NAMES
                    options['target_names']=SUPPORTED_TARGET_NAMES
                return process_inventory(**options)
            except OwnershipUnavailable:
                if attempt==2:raise
                # Only retry the observation; callers' accepted release or
                # launch operations are never repeated by this probe.
                sleep((.025,.075)[attempt])
    except (OSError,ValueError,RuntimeError,ImportError):raise ProductError('candidate_process_ownership_unavailable') from None
def require_idle(install,rows=None):
    rows=process_rows(install) if rows is None else rows
    prefix=str(install/'versions').replace('\\','/').casefold()+'/'
    live={r['ProcessId']:r for r in rows}
    # Metadata alone does not establish idleness. Exact owned command/image paths and
    # still-live retained owner PIDs both block; ambiguous PID reuse also blocks.
    if any(version_process(r,prefix) for r in rows):raise ProductError('candidate_owned_process_running')
    for relative,fields in [('web-host/supervisor.json',['pid']),('web-host/health.json',['pid']),
      ('codex-web-bridge/status.json',['pid','runtimePid']),('harness-launcher/owner.json',['child_pid','supervisor_pid'])]:
        path=install/'data'/relative
        no_link_directory(path.parent)
        if not path.exists():continue
        value=read_json(path,32768)
        if not isinstance(value,dict):raise ProductError('candidate_owner_metadata_unavailable')
        if value.get('state') in ('stopped','not_started'):continue
        if any(type(value.get(field)) is int and value[field] in live for field in fields):raise ProductError('candidate_owner_pid_ambiguous')

def install(archive,directory,expected_sha256,*,on_phase=None):
    phase=on_phase or (lambda _:None)
    directory=no_link_directory(directory);directory.mkdir(parents=True,exist_ok=True)
    phase('verify_archive')
    manifest=verify_archive(archive,expected_sha256);build=manifest['build_id']
    phase('guard')
    with FileLease(directory/'.release.lock'):
        data=directory/'data';versions=directory/'versions'
        no_link_directory(data);no_link_directory(versions);data.mkdir(exist_ok=True);versions.mkdir(exist_ok=True)
        marker=directory/'installation.json'
        if marker.exists():
            identity=read_json(marker,8192)
            if identity.get('product')!=PRODUCT or identity.get('schema')!=1 or identity.get('root')!=str(directory.resolve()):raise ProductError('candidate_install_identity_invalid')
        else:
            if any(p.name not in {'.release.lock','data','versions'} for p in directory.iterdir()):
                raise ProductError('candidate_existing_root_not_adopted')
            if any(data.iterdir()) or any(versions.iterdir()):raise ProductError('candidate_existing_data_not_adopted')
            atomic_json(marker,{'schema':1,'product':PRODUCT,'installation_id':uuid.uuid4().hex,'root':str(directory.resolve()),'data_epoch':manifest['data_epoch']})
        target=versions/build
        manager=directory/'manager';no_link_directory(manager)
        if manager.exists() or (directory/'.manager-upgrade.json').exists():
            phase('manager');ensure_manager(directory,target)
        elif (directory/'LAUNCH.cmd').exists():raise ProductError('candidate_existing_launcher_not_overwritten')
        if target.exists():
            phase('verify_linked')
            if verify_version(target,data)!=manifest:raise ProductError('candidate_existing_version_differs')
            phase('manager')
            ensure_manager(directory,target)
            return {'state':'candidate_installed','build_id':build,'selected':False,'replayed':True,'model_sends':0}
        pending=versions/('installing-'+uuid.uuid4().hex);pending.mkdir()
        phase('extract')
        with zipfile.ZipFile(archive) as z:
            for info in archive_members(z,manifest):
                path=pending/info.filename;path.parent.mkdir(parents=True,exist_ok=True)
                with z.open(info) as src,path.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
        phase('verify_archive_after_extract')
        if file_hash(Path(archive))['sha256']!=expected_sha256:raise ProductError('candidate_archive_changed_during_install')
        phase('verify_pending')
        if verify_version(pending)!=manifest:raise ProductError('candidate_install_readback_failed')
        phase('junction');junction(pending/'.local',data)
        phase('verify_linked');verify_version(pending,data)
        phase('publish');publish_directory(pending,target)
        phase('manager')
        ensure_manager(directory,target)
        return {'state':'candidate_installed','build_id':build,'selected':False,'replayed':False,'model_sends':0}

def installation_identity(directory):
    no_link_directory(directory/'data');no_link_directory(directory/'versions')
    no_link_directory(directory/'manager')
    marker=read_json(directory/'installation.json',8192)
    if (not isinstance(marker,dict) or marker.get('product')!=PRODUCT or marker.get('schema')!=1 or
        marker.get('root')!=str(directory.resolve()) or not re.fullmatch(r'[a-f0-9]{32}',str(marker.get('installation_id',''))) or
        not (directory/'data').is_dir() or not (directory/'versions').is_dir()):raise ProductError('candidate_install_identity_invalid')
    return marker
def verify_manager(directory):
    manager=directory/'manager';no_link_directory(manager)
    identity=read_json(manager/'identity.json',8192)
    names={'manager/web_workspace_release.py','manager/product_runtime.py','LAUNCH.cmd'}
    if not isinstance(identity,dict) or identity.get('protocol')!=1 or not isinstance(identity.get('files'),dict) or set(identity['files']) not in (names,names|{'manager/windows_process_owner.py'}):
        raise ProductError('candidate_manager_identity_invalid')
    for name,entry in identity['files'].items():
        if file_hash(plain(directory/name,directory))!=entry:raise ProductError('candidate_manager_changed')
    return identity

def manager_snapshot(directory,folder,identity):
    """CAS bytes and original filesystem identity, excluding all business data."""
    no_link_directory(folder)
    names={name.split('/')[-1] for name in identity['files'] if name.startswith('manager/')}|{'identity.json'}
    if {p.name for p in folder.iterdir()}!=names:raise ProductError('candidate_manager_contents_unknown')
    files={}
    for name in sorted(names):
        target=plain(folder/name,directory);value=file_hash(target);s=target.stat()
        files[name]={'content':value,'identity':[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns]}
        expected=identity['files'].get('manager/'+name)
        if expected is not None and value!=expected:raise ProductError('candidate_manager_changed')
    folder_stat=folder.stat()
    launcher=plain(directory/'LAUNCH.cmd',directory)
    if file_hash(launcher)!=identity['files']['LAUNCH.cmd']:raise ProductError('candidate_manager_changed')
    return {'directory':[folder_stat.st_dev,folder_stat.st_ino],'files':files,'launcher':file_hash(launcher)}

def stage_manager(directory,code):
    manifest=validate_manifest(read_json(code/MANIFEST));names=['web_workspace_release.py','product_runtime.py']
    if 'scripts/windows_process_owner.py' in manifest['files']:names.append('windows_process_owner.py')
    stage=directory/('manager-preparing-'+uuid.uuid4().hex);stage.mkdir()
    entries={}
    for name in names:
        source=plain(code/'scripts'/name,code);expected=manifest['files'].get('scripts/'+name)
        if not expected or file_hash(source)!=expected:raise ProductError('candidate_manager_source_changed')
        shutil.copyfile(source,stage/name)
        if file_hash(stage/name)!=expected:raise ProductError('candidate_manager_stage_changed')
        entries['manager/'+name]=expected
    entries['LAUNCH.cmd']={'sha256':sha(LAUNCHER),'bytes':len(LAUNCHER)}
    identity={'protocol':1,'files':entries};atomic_json(stage/'identity.json',identity)
    return stage,identity

def known_manager_source(directory,identity,*,legacy_only=False):
    expected={'manager/web_workspace_release.py','manager/product_runtime.py','LAUNCH.cmd'}
    allowed=(expected,) if legacy_only else (expected,expected|{'manager/windows_process_owner.py'})
    if not isinstance(identity,dict) or identity.get('protocol')!=1 or not isinstance(identity.get('files'),dict) or set(identity['files']) not in allowed or identity['files']['LAUNCH.cmd']!={'sha256':sha(LAUNCHER),'bytes':len(LAUNCHER)}:
        raise ProductError('candidate_manager_upgrade_original_unknown')
    # An identity file cannot bless arbitrary changed manager source. Every
    # original module must match one complete verified installed release.
    for code in (directory/'versions').iterdir():
        if not BUILD.fullmatch(code.name):continue
        no_link_directory(code);manifest=validate_manifest(read_json(code/MANIFEST))
        names=[key.split('/')[-1] for key in identity['files'] if key.startswith('manager/')]
        if ('scripts/windows_process_owner.py' in manifest['files'])!=('windows_process_owner.py' in names):continue
        if all(manifest['files'].get('scripts/'+name)==identity['files']['manager/'+name] and
               file_hash(plain(code/'scripts'/name,code))==identity['files']['manager/'+name]
               for name in names):
            verify_version(code,directory/'data' if linked(code/'.local') else None)
            return code
    raise ProductError('candidate_manager_upgrade_original_unknown')

def known_legacy_manager(directory,identity):
    return known_manager_source(directory,identity,legacy_only=True)

def execute_manager_upgrade(directory,transaction):
    marker=directory/'.manager-upgrade.json'
    expected={'schema','purpose','state','source_build','stage','backup','original_identity','new_identity','original_snapshot','new_snapshot'}
    if (not isinstance(transaction,dict) or set(transaction)!=expected or transaction['schema']!=1 or transaction['purpose'] not in ('native_owner_probe','verified_release') or transaction['state']!='prepared' or
        not BUILD.fullmatch(str(transaction['source_build'])) or not re.fullmatch(r'manager-preparing-[a-f0-9]{32}',str(transaction['stage'])) or
        not re.fullmatch(r'manager-previous-[a-f0-9]{32}',str(transaction['backup']))):raise ProductError('candidate_manager_upgrade_unknown')
    manager=directory/'manager';stage=directory/transaction['stage'];backup=directory/transaction['backup']
    for folder in (manager,stage,backup):no_link_directory(folder)
    known_manager_source(directory,transaction['original_identity'],legacy_only=transaction['purpose']=='native_owner_probe')
    source=directory/'versions'/transaction['source_build'];no_link_directory(source)
    manifest=verify_version(source,directory/'data' if linked(source/'.local') else None)
    if not isinstance(transaction['new_identity'],dict) or transaction['new_identity'].get('protocol')!=1 or set(transaction['new_identity'].get('files',{}))!={'manager/web_workspace_release.py','manager/product_runtime.py','manager/windows_process_owner.py','LAUNCH.cmd'}:
        raise ProductError('candidate_manager_upgrade_unknown')
    if any(manifest['files'].get('scripts/'+name)!=entry for name,entry in
           ((key.split('/')[-1],value) for key,value in transaction['new_identity']['files'].items() if key.startswith('manager/'))):
        raise ProductError('candidate_manager_source_changed')
    with FileLease(directory/'data/.run.lock'):
        require_idle(directory)
        if manager.exists():
            current=read_json(manager/'identity.json',8192)
            snapshot=manager_snapshot(directory,manager,current)
            if current==transaction['new_identity'] and snapshot==transaction['new_snapshot']:
                if not backup.exists() or manager_snapshot(directory,backup,transaction['original_identity'])!=transaction['original_snapshot']:raise ProductError('candidate_manager_upgrade_unknown')
                transaction={**transaction,'state':'completed'};atomic_json(marker,transaction);return
            if current!=transaction['original_identity'] or snapshot!=transaction['original_snapshot'] or backup.exists():raise ProductError('candidate_manager_changed')
        elif not backup.exists() or manager_snapshot(directory,backup,transaction['original_identity'])!=transaction['original_snapshot']:
            raise ProductError('candidate_manager_upgrade_unknown')
        if not stage.exists() or manager_snapshot(directory,stage,transaction['new_identity'])!=transaction['new_snapshot']:raise ProductError('candidate_manager_stage_changed')
        # Original launch admission is held. The complete staged directory is
        # published in one rename; no half-written manager becomes runnable.
        try:
            if manager.exists():
                if manager_snapshot(directory,manager,transaction['original_identity'])!=transaction['original_snapshot']:raise ProductError('candidate_manager_changed')
                os.replace(manager,backup)
            if manager_snapshot(directory,backup,transaction['original_identity'])!=transaction['original_snapshot']:raise ProductError('candidate_manager_changed')
            os.replace(stage,manager)
        except (OSError,ProductError):
            if not manager.exists() and backup.exists():
                s=backup.stat()
                if [s.st_dev,s.st_ino]==transaction['original_snapshot']['directory']:
                    # Restore that same directory even if a concurrent edit
                    # made its bytes unknown; preserve the edit and refuse.
                    os.replace(backup,manager);atomic_json(marker,{**transaction,'state':'rolled_back'})
            raise
        if manager_snapshot(directory,manager,transaction['new_identity'])!=transaction['new_snapshot']:raise ProductError('candidate_manager_stage_changed')
        verify_manager(directory);atomic_json(marker,{**transaction,'state':'completed'})

def upgrade_legacy_manager(directory,code,identity):
    upgrade_manager(directory,code,identity,purpose='native_owner_probe')

def upgrade_manager(directory,code,identity,*,purpose='verified_release'):
    known_manager_source(directory,identity,legacy_only=purpose=='native_owner_probe')
    verify_version(code,directory/'data' if linked(code/'.local') else None);require_idle(directory)
    original=manager_snapshot(directory,directory/'manager',identity)
    stage,new_identity=stage_manager(directory,code)
    transaction={'schema':1,'purpose':purpose,'state':'prepared','source_build':code.name,'stage':stage.name,
                 'backup':'manager-previous-'+uuid.uuid4().hex,'original_identity':identity,'new_identity':new_identity,
                 'original_snapshot':original,'new_snapshot':manager_snapshot(directory,stage,new_identity)}
    atomic_json(directory/'.manager-upgrade.json',transaction)
    execute_manager_upgrade(directory,transaction)
def ensure_manager(directory,code):
    """Recover only our complete staged manager and known launcher bytes.

    Unknown/incomplete preexisting manager contents are never overwritten. The
    version may already be installed after a crash; replay must not falsely
    report success while its launch entry is absent.
    """
    manager=directory/'manager';no_link_directory(manager)
    transition=directory/'.manager-upgrade.json'
    if transition.exists():
        transaction=read_json(transition,32768)
        if not isinstance(transaction,dict):raise ProductError('candidate_manager_upgrade_unknown')
        if transaction.get('state')=='prepared':execute_manager_upgrade(directory,transaction)
        elif transaction.get('state') not in ('completed','rolled_back'):raise ProductError('candidate_manager_upgrade_unknown')
    if not manager.exists():
        if (directory/'LAUNCH.cmd').exists():raise ProductError('candidate_existing_launcher_not_overwritten')
        stage,identity=stage_manager(directory,code);publish_directory(stage,manager)
    identity=read_json(manager/'identity.json',8192)
    expected={'sha256':sha(LAUNCHER),'bytes':len(LAUNCHER)}
    if identity.get('protocol')!=1 or identity.get('files',{}).get('LAUNCH.cmd')!=expected:
        raise ProductError('candidate_install_incomplete')
    for name in [key for key in identity.get('files',{}) if key.startswith('manager/')]:
        if file_hash(plain(directory/name,directory))!=identity['files'].get(name):raise ProductError('candidate_install_incomplete')
    launcher=directory/'LAUNCH.cmd'
    if not launcher.exists():
        with launcher.open('xb') as f:f.write(LAUNCHER)
    verify_manager(directory)
    if 'manager/windows_process_owner.py' not in identity['files'] and (code/'scripts/windows_process_owner.py').is_file():
        upgrade_legacy_manager(directory,code,identity)
    elif code.is_dir() and (code/'scripts/windows_process_owner.py').is_file():
        manifest=validate_manifest(read_json(code/MANIFEST))
        expected_files={'manager/'+name:manifest['files']['scripts/'+name] for name in ('web_workspace_release.py','product_runtime.py','windows_process_owner.py')}
        expected_files['LAUNCH.cmd']=expected
        if identity['files']!=expected_files:
            original=known_manager_source(directory,identity)
            # Replaying an archived release must not downgrade the executable
            # manager. Only a later frozen release can replace a modern one.
            old_manifest=read_json(original/MANIFEST)
            try:
                newer=datetime.fromisoformat(manifest['created_at'].replace('Z','+00:00'))>datetime.fromisoformat(old_manifest['created_at'].replace('Z','+00:00'))
            except (KeyError,TypeError,ValueError):raise ProductError('candidate_manager_source_changed') from None
            if newer:upgrade_manager(directory,code,identity)
def selected(directory):
    marker=installation_identity(directory)
    pointer=directory/'active.json'
    if not pointer.exists():return None
    value=read_json(pointer,8192)
    if not isinstance(value,dict) or set(value)!={'schema','product','build_id','previous','manifest_sha256','installation_id','selected_at'} or value['schema']!=1 or value['product']!=PRODUCT or not BUILD.fullmatch(str(value['build_id'])) or value['previous'] is not None and not BUILD.fullmatch(str(value['previous'])):
        raise ProductError('candidate_selection_invalid')
    if marker.get('product')!=PRODUCT or marker.get('schema')!=1 or marker.get('root')!=str(directory.resolve()) or value['installation_id']!=marker.get('installation_id'):
        raise ProductError('candidate_selection_identity_changed')
    code=directory/'versions'/value['build_id'];no_link_directory(code)
    manifest=verify_version(code,directory/'data')
    if file_hash(code/MANIFEST)['sha256']!=value['manifest_sha256']:raise ProductError('candidate_selected_manifest_changed')
    return value
def select(directory,build,expected_current,*,owner_probe=require_idle,before_publish=None):
    directory=no_link_directory(directory).resolve()
    if not BUILD.fullmatch(str(build)):raise ProductError('candidate_exact_build_required')
    installation_identity(directory);verify_manager(directory)
    with FileLease(directory/'.release.lock'),ExitStack() as locks:
        locks.enter_context(FileLease(directory/'data/.run.lock'))
        original=selected(directory);actual=original['build_id'] if original else None
        if actual!=expected_current:raise ProductError('candidate_selection_changed')
        owner_probe(directory)
        code=directory/'versions'/build;no_link_directory(code);manifest=verify_version(code,directory/'data')
        identity=read_json(directory/'installation.json',8192)
        if manifest['data_epoch']!=identity['data_epoch']:raise ProductError('candidate_data_epoch_requires_migration')
        if original:
            current=read_json(directory/'versions'/actual/MANIFEST)
            # Private runtimes belong to each verified version directory. Their
            # bytes may change on upgrade or rollback; shared runtime identities
            # and the runtime path contract still require explicit migration.
            compatible=lambda contract:{key:value for key,value in contract.items() if key!='private_runtime_sha256'}
            if compatible(current['runtime_contract'])!=compatible(manifest['runtime_contract']):
                raise ProductError('candidate_runtime_change_requires_migration')
        lock=directory/'data/harness/.instance.lock'
        no_link_directory(lock.parent)
        if lock.exists():locks.enter_context(FileLease(lock))
        bun=directory/'data/runtimes/bun-1.4.0/bun.exe';entry=manifest['files']['runtime/bun-1.4.0/bun.exe']
        if bun.exists():
            plain(bun,directory/'data')
            if file_hash(bun)!=entry:raise ProductError('candidate_shared_runtime_changed')
        else:
            no_link_directory(bun.parent)
            bun.parent.mkdir(parents=True,exist_ok=True)
            no_link_directory(bun.parent)
            staged=bun.parent/('bun-preparing-'+uuid.uuid4().hex+'.tmp')
            try:
                shutil.copyfile(code/'runtime/bun-1.4.0/bun.exe',staged)
                if file_hash(staged)!=entry:raise ProductError('candidate_shared_runtime_copy_failed')
                if bun.exists() or linked(bun):raise ProductError('candidate_shared_runtime_changed')
                os.replace(staged,bun)
            finally:
                # Only this newly allocated private temporary file is removed;
                # an existing runtime is never replaced or repaired implicitly.
                if staged.exists():staged.unlink()
        if before_publish is not None:before_publish(code)
        if actual==build:return original
        value={'schema':1,'product':PRODUCT,'build_id':build,'previous':actual,'manifest_sha256':file_hash(code/MANIFEST)['sha256'],
          'installation_id':identity['installation_id'],'selected_at':utc()}
        atomic_json(directory/'active.json',value);return value
def inspect(directory):
    directory=no_link_directory(directory).resolve();value=selected(directory)
    if not value:raise ProductError('candidate_no_active_build')
    verify_manager(directory)
    code=directory/'versions'/value['build_id'];manifest=read_json(code/MANIFEST)
    bun=plain(directory/'data/runtimes/bun-1.4.0/bun.exe',directory/'data')
    if file_hash(bun)!=manifest['files']['runtime/bun-1.4.0/bun.exe']:raise ProductError('candidate_shared_runtime_changed')
    if sys.version_info<(3,11):raise ProductError('candidate_python_311_required')
    python=str(code/manifest['runtime_contract']['private_python']) if 'private_python' in manifest['runtime_contract'] else sys.executable
    return {'state':'candidate_launch_verified','build_id':value['build_id'],'version':manifest['version'],
      'code_root':str(code),'data_root':str(directory/'data'),'python':python,'model_sends':0,
      'application_started':False,'user_login_included':False,'license_state':manifest['license_state']}
def launch_receipts(directory):
    for relative in ('preview-launch.json','web-host/shared-entry-start.json'):
        path=directory/'data'/relative;no_link_directory(path.parent)
        if not path.exists():continue
        value=read_json(path,32768)
        if not isinstance(value,dict):raise ProductError('candidate_owner_metadata_unavailable')
        if value.get('completion_unknown') is True:raise ProductError('candidate_original_start_completion_unknown')

def focus_running_workspace(code,directory):
    sys.path.insert(0,str(code/'scripts'))
    from web_host_supervisor_owner import existing_browser,focus_existing
    browser=existing_browser(code,directory/'data/web-host',own_pid=os.getpid())
    if browser is None:raise ProductError('web_workspace_original_owner_unverified')
    return focus_existing(browser,code,subprocess.Popen)

def launch(directory,inspect_only=False):
    directory=no_link_directory(directory).resolve()
    installation_identity(directory);verify_manager(directory)
    run_lease=FileLease(directory/'data/.run.lock')
    try:
        with FileLease(directory/'.release.lock'):
            report=inspect(directory)
            code=Path(report['code_root'])
            if inspect_only:return report
            launch_receipts(directory)
            try:run_lease.__enter__()
            except ProductError as error:
                if str(error)!='data_in_use_no_process_stopped':raise
                # A held launch lease is never stolen or treated as stale. The
                # only accepted duplicate is a proven no-takeover focus child.
                result=focus_running_workspace(code,directory)
                return {'state':'candidate_existing_focused','build_id':report['build_id'],'exit_code':result}
            harness=directory/'data/harness/.instance.lock';no_link_directory(harness.parent)
            if harness.exists():
                with FileLease(harness):pass
        # Explicit invocation only. Locks remain held while the original normal
        # supervisor and its owned browser run. Release admission itself is
        # short, allowing another invocation to prove and focus this owner.
        env={**os.environ,'CLW_PYTHON':report['python']}
        contract=read_json(code/MANIFEST)['runtime_contract']
        if 'powershell' in contract:
            env['CLW_POWERSHELL']=str(code/contract['powershell'])
            env['PATH']=str((code/contract['powershell']).parent)+os.pathsep+str(Path(report['python']).parent)+os.pathsep+env.get('PATH','')
        result=subprocess.run([report['python'],'-B',str(code/'scripts/web_host_launcher.py')],cwd=code,env=env)
        return {'state':'candidate_supervisor_exited','build_id':report['build_id'],'exit_code':result.returncode}
    finally:run_lease.__exit__(None,None,None)

def main():
    p=argparse.ArgumentParser(description=__doc__);commands=p.add_subparsers(dest='command',required=True)
    build=commands.add_parser('prepare');build.add_argument('--root',type=Path,default=ROOT);build.add_argument('--output',type=Path,required=True);build.add_argument('--bun-notice',type=Path,required=True)
    build.add_argument('--runtime-payload',type=Path);build.add_argument('--notice',type=Path)
    install_cmd=commands.add_parser('install');install_cmd.add_argument('--archive',type=Path,required=True);install_cmd.add_argument('--install-root',type=Path,required=True);install_cmd.add_argument('--sha256',required=True)
    choose=commands.add_parser('select');choose.add_argument('--install-root',type=Path,required=True);choose.add_argument('--build',required=True);choose.add_argument('--expected-current',required=True,help='Exact build ID, or none for initial selection')
    for name in ['inspect','launch']:
        q=commands.add_parser(name);q.add_argument('--install-root',type=Path,required=True)
        if name=='launch':q.add_argument('--inspect-only',action='store_true')
    args=p.parse_args()
    try:
        if args.command=='prepare':result=prepare(args.root,args.output,args.bun_notice,runtime_payload=args.runtime_payload,notice_file=args.notice)
        elif args.command=='install':result=install(args.archive,args.install_root,args.sha256)
        elif args.command=='select':result=select(args.install_root,args.build,None if args.expected_current=='none' else args.expected_current)
        elif args.command=='inspect':result=inspect(args.install_root)
        else:result=launch(args.install_root,args.inspect_only)
        print(json.dumps(result,ensure_ascii=False));return 0
    except (ProductError,OSError,subprocess.SubprocessError) as error:
        print(json.dumps({'state':'rejected','code':str(error) if isinstance(error,ProductError) else 'candidate_io_or_dependency_unavailable',
          'model_sends':0,'processes_stopped':False}));return 2
if __name__=='__main__':raise SystemExit(main())
