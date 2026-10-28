"""Web workspace startup identity; retains the original Harness data owner."""
from copy import deepcopy
import json,os,platform,re,subprocess,threading,time,uuid
from pathlib import Path
from product_runtime import RuntimeIdentity,ProductError,snapshot_payload,hash_payload,digest,json_bytes,utc,COMMIT

PRODUCT='clw-web-workspace'
VERSION=re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\Z')

def workspace_hashes(root,static=None):
    """Bounded source observation; binaries are verified once by release startup."""
    from web_workspace_release import plain,file_hash,linked
    root=Path(root).resolve();hashes=hash_payload(static if static is not None else snapshot_payload(root))
    marker=root/'_clw_web_release.json'
    if marker.exists():
        entry=file_hash(plain(marker,root))
        if entry['bytes']>8*1024*1024:raise ProductError('workspace_runtime_source_bounds')
        hashes['_clw_web_release.json']=entry['sha256']
    for folder,recurse in [('apps/web-host',False),('apps/codex-web-bridge',False),
      ('apps/codex-web-bridge/upstream/src',True),('apps/codex-web-bridge/upstream/launcher/electron',True)]:
        base=root/folder
        if not base.exists():continue
        if linked(base):raise ProductError('workspace_runtime_source_link')
        for current,dirs,names in os.walk(base,followlinks=False):
            for name in dirs:
                if linked(Path(current)/name):raise ProductError('workspace_runtime_source_link')
            dirs[:]=[d for d in dirs if recurse and d not in {'node_modules','tests','__pycache__','.git'}]
            for name in names:
                p=Path(current)/name
                if p.suffix.lower() not in {'.cjs','.js','.ts','.mjs','.html','.css','.json'}:continue
                rel=p.relative_to(root).as_posix()
                # Root JSON files are public implementation rules/package data.
                entry=file_hash(plain(p,root))
                if entry['bytes']>2*1024*1024 or len(hashes)>=2048:raise ProductError('workspace_runtime_source_bounds')
                hashes[rel]=entry['sha256']
    return dict(sorted(hashes.items()))

class WebWorkspaceRuntimeIdentity:
    def __init__(self,root,channel='development',state_id=None):
        if channel not in {'development','candidate','stable','test'}:raise ProductError('invalid_channel')
        self.root=Path(root).resolve();self.files=snapshot_payload(self.root)
        package=json.loads(self.files['package.json'])
        if package.get('name')!=PRODUCT or not VERSION.fullmatch(str(package.get('version',''))):raise ProductError('invalid_product_package')
        self.hashes=workspace_hashes(self.root,self.files);manifest=None
        from web_workspace_release import MANIFEST,verify_version,file_hash
        marker=self.root/MANIFEST
        if marker.exists():
            local=self.root/'.local'
            manifest=verify_version(self.root,local.resolve() if local.exists() else None)
            if manifest['version']!=package['version'] or manifest['data_epoch']!=package.get('clw_data_epoch',1):raise ProductError('workspace_runtime_package_mismatch')
            # An edit during manifest verification cannot be called loaded code.
            if workspace_hashes(self.root)!=self.hashes:raise ProductError('workspace_runtime_changed_during_start')
        if channel in {'stable','candidate'} and manifest is None:raise ProductError('fixed_channel_requires_release')
        commit=manifest['source_commit'] if manifest else None
        if manifest is None:
            try:
                result=subprocess.run(['git','-C',str(self.root),'rev-parse','HEAD'],capture_output=True,text=True,timeout=3)
                if result.returncode==0 and COMMIT.fullmatch(result.stdout.strip()):commit=result.stdout.strip()
            except (OSError,subprocess.TimeoutExpired):pass
        self.base={'schema_version':1,'product':PRODUCT,'version':package['version'],
          'channel':'candidate' if manifest is not None and channel=='development' else channel,
          'source_commit':commit,'payload_sha256':manifest['payload_sha256'] if manifest else digest(json_bytes(self.hashes)),
          'source_snapshot_sha256':digest(json_bytes(self.hashes)),'fixed_release':manifest is not None,
          'commit_describes_payload':False,'source_kind':manifest['source_kind'] if manifest else 'observed_current_worktree',
          'verified_at_start':manifest is not None,'validation':'not_inferred_from_manifest',
          'instance_id':uuid.uuid4().hex,'pid':os.getpid(),'started_at':utc(),'state_id':state_id,
          'data_epoch':package.get('clw_data_epoch',1),'python_version':platform.python_version(),
          'automatic_restart':False,'automatic_model_calls':False,'static_assets':'startup_snapshot',
          'disk_observation_coverage':'harness_desktop_and_adapter_source',
          'state_owner_contract':'existing_harness_state_identity_preserved'}
        if manifest:self.base.update(build_id=manifest['build_id'],manifest_sha256=file_hash(marker)['sha256'])
        self._lock=threading.Lock();self._until=0;self._disk=None

    def info(self):
        with self._lock:
            if time.monotonic()>=self._until:
                try:
                    equal=workspace_hashes(self.root)==self.hashes
                    self._disk={'disk_status':'unchanged' if equal else 'changed','restart_required':not equal}
                except (OSError,ValueError):self._disk={'disk_status':'unavailable','restart_required':True}
                self._until=time.monotonic()+3
            return {**deepcopy(self.base),**self._disk,'observed_at':utc()}

def runtime_identity(root,channel='development',state_id=None):
    """Explicit package routing; the legacy validator remains strict."""
    from product_runtime import read_json
    package=read_json(Path(root)/'package.json')
    identity=WebWorkspaceRuntimeIdentity if package.get('name')==PRODUCT else RuntimeIdentity
    return identity(root,channel,state_id)
