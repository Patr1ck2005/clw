'use strict';
// Release hashes describe physical archives. Electron's node:fs exposes an
// .asar archive as a virtual directory, so every check must use original-fs.
const fs=process.versions.electron?require('original-fs'):require('node:fs'),
  path=require('node:path'),crypto=require('node:crypto');
const FLAG='--clw-isolated-check';
function prepareIsolatedCheck(root,argv){
  const requested=argv.filter(value=>typeof value==='string'&&(value===FLAG||value.startsWith(FLAG+'=')));
  if(!requested.length)return false;
  if(requested.length!==1||requested[0]!==FLAG)throw Error('isolated_app_check_flag_invalid');
  const code=fs.realpathSync(root),install=path.dirname(path.dirname(code));
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  const manifest=read(path.join(code,'_clw_web_release.json')),identity=read(path.join(install,'installation.json')),active=read(path.join(install,'active.json'));
  if(path.basename(path.dirname(code))!=='versions'||identity.schema!==1||identity.product!=='clw-web-workspace'||
    fs.realpathSync(identity.root)!==install||manifest.product!=='clw-web-workspace'||manifest.build_id!==path.basename(code)||
    active.build_id!==manifest.build_id||active.installation_id!==identity.installation_id||
    manifest.schema!==1||!/^\d{8}T\d{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(manifest.build_id||'')||
    !/^[a-f0-9]{32}$/.test(identity.installation_id||''))throw Error('isolated_app_check_requires_fixed_installation');
  const manifestHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(code,'_clw_web_release.json'))).digest('hex');
  if(active.manifest_sha256!==manifestHash)throw Error('isolated_app_check_manifest_changed');
  const data=fs.realpathSync(path.join(code,'.local'));
  if(data!==fs.realpathSync(path.join(install,'data')))throw Error('isolated_app_check_data_changed');
  const entries=fs.readdirSync(data),freshPreview=entries.includes('preview-installation.json');
  const permitted=['runtimes','.run.lock',...(freshPreview?['preview-installation.json','preview-installation.lock','preview-private']:[])];
  if(entries.some(name=>!permitted.includes(name)))throw Error('isolated_app_check_requires_fresh_empty_data');
  if(freshPreview){
    const settings=read(path.join(data,'preview-installation.json')),native=manifest.runtime_contract?.native;
    const expected={cli:'webcodex.exe',server:'webcodex-server.exe',runner:'webcodex-runner.exe',tunnel:'tunnel-client.exe'};
    if(settings.schema!==1||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(settings.installation_id||'')||
       settings.backend?.mode!=='owned'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(settings.backend?.origin||'')||
       JSON.stringify(settings.network)!==JSON.stringify({mode:'system'})||JSON.stringify(settings.accounts)!==JSON.stringify([{id:'A'}])||
       !Array.isArray(settings.projectRoots)||settings.projectRoots.length||settings.auto_connect!==true||
       !native||Object.keys(settings.binaries||{}).length!==4||Object.entries(expected).some(([key,name])=>
         native[key]!=='runtime/native/'+name||path.resolve(settings.binaries[key]||'')!==path.join(code,'runtime','native',name)))
      throw Error('isolated_app_check_requires_fresh_empty_data');
    const privateFolder=path.join(data,'preview-private');
    if(fs.existsSync(privateFolder)&&(fs.realpathSync(privateFolder)!==privateFolder||fs.readdirSync(privateFolder).length))
      throw Error('isolated_app_check_requires_fresh_empty_data');
  }
  const files=manifest.files;
  if(!files||Array.isArray(files)||!files['apps/web-host/main.cjs']||!files['apps/web-host/isolated-app-check.cjs']||Object.keys(files).length>24000)
    throw Error('isolated_app_check_manifest_invalid');
  const buffer=Buffer.allocUnsafe(1024*1024);let total=0;
  for(const [name,expected] of Object.entries(files)){
    if(!name.split('/').every(part=>/^[A-Za-z0-9_@.+-]+$/.test(part)&&!['.','..'].includes(part))||
      !Number.isSafeInteger(expected.bytes)||expected.bytes<0||expected.bytes>320*1024*1024||!/^[a-f0-9]{64}$/.test(expected.sha256||''))
      throw Error('isolated_app_check_manifest_invalid');
    const file=path.join(code,...name.split('/'));
    if(fs.realpathSync(file)!==file)throw Error('isolated_app_check_source_not_frozen');
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size!==expected.bytes)throw Error('isolated_app_check_source_not_frozen');
    const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r');let bytes=0;
    try{let length;while((length=fs.readSync(fd,buffer,0,buffer.length,null))>0){hash.update(buffer.subarray(0,length));bytes+=length;}}
    finally{fs.closeSync(fd);}
    total+=bytes;
    if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256||total>2*1024*1024*1024)throw Error('isolated_app_check_source_not_frozen');
  }
  fs.writeFileSync(path.join(data,'.isolated-app-check.json'),JSON.stringify({version:1,pid:process.pid,
    code_root:code,installation_id:identity.installation_id,host_port:0,started_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  return true;
}
module.exports={prepareIsolatedCheck,FLAG};
