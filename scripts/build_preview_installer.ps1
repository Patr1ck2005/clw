param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$InnoCompiler,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$PythonExecutable='python.exe',
  [string]$SourceMaterialsDirectory,
  [switch]$RequireSourceMaterials
)
$ErrorActionPreference='Stop'
if ($RequireSourceMaterials -and !$SourceMaterialsDirectory) {throw 'Final distribution requires complete third-party source materials.'}
$Root=Split-Path -Parent $PSScriptRoot
$Archive=(Resolve-Path -LiteralPath $Archive).Path
$InnoCompiler=(Resolve-Path -LiteralPath $InnoCompiler).Path
$CompilerVersion='6.7.3'
$CompilerHash=(Get-FileHash -LiteralPath $InnoCompiler -Algorithm SHA256).Hash.ToLowerInvariant()
if ($CompilerHash -ne '0a8757031b33777e4c9cbffee40f11a5062b36d25cbe144c1db73b6102b80ad7') {throw 'The verified official Inno Setup 6.7.3 compiler is required.'}
$TemplatePath=Join-Path $Root 'packaging/preview.iss'
$TemplateHash=(Get-FileHash -LiteralPath $TemplatePath -Algorithm SHA256).Hash.ToLowerInvariant()
$BuilderHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if (!(Test-Path -LiteralPath 'E:/' -PathType Container)) {throw 'The approved E: workspace is unavailable.'}
$ApprovedRoot=[IO.Path]::GetFullPath('E:/35311-CLWWorkspace/free-preview-20261017')
if (!$OutputDirectory.StartsWith($ApprovedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and $OutputDirectory -ne $ApprovedRoot) {throw 'Build output must remain in the approved E: preview workspace.'}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$Probe=Join-Path $OutputDirectory ('write-probe-'+[guid]::NewGuid().ToString('N')+'.tmp')
[IO.File]::WriteAllText($Probe,'preview build write probe'); [IO.File]::Delete($Probe)
$Stage=Join-Path $OutputDirectory ('installer-build-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
$Prepare=@'
import json, pathlib, sys, zipfile
root,archive,stage=map(pathlib.Path,sys.argv[1:4])
source_directory=pathlib.Path(sys.argv[4]) if len(sys.argv)>4 else None
require_sources=len(sys.argv)>5 and sys.argv[5]=='required'
sys.path.insert(0,str(root/'scripts'))
import web_workspace_release as release
manifest=release.verify_archive(archive)
if manifest['runtime_contract'].get('private_python')!=release.PRIVATE_RUNTIME['private_python']:
    raise SystemExit('private runtime preview archive required')
names={n for n in manifest['files'] if n.startswith('runtime/python/')}
names.update(release.BOOTSTRAP_SCRIPTS)
if not names.issubset(manifest['files']):raise SystemExit('installer bootstrap scripts missing')
with zipfile.ZipFile(archive) as source:
    for name in sorted(names):
        target=stage/'bootstrap'/name;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(source.read(name))
    (stage/'PREVIEW-LICENSE.txt').write_bytes(source.read('LICENSE'))
    launch_name='CLW.vbs' if b'PREVIEW_GUI_LAUNCHER' in source.read('scripts/preview_installer.py') else 'CLW.cmd'
    lifecycle_result=b'--result-file' in source.read('scripts/preview_installer.py')
result={'schema':1,'build_id':manifest['build_id'],'version':manifest['version'],
        'archive':str(archive),'archive_sha256':release.file_hash(archive)['sha256'],
        'bootstrap':str(stage/'bootstrap'),'platform':'windows-x64','signed':False,'launch_name':launch_name}
result['lifecycle_result']=lifecycle_result
source_files=[];file_lines=[];code_lines=['procedure ExtractSourceMaterials;','begin',"  if not WizardIsTaskSelected('sources') then exit;"]
result['source_materials_complete']=False
if source_directory:
    release.no_link_directory(source_directory)
    if not source_directory.is_dir():raise SystemExit('source materials directory missing')
    material_manifest=source_directory/'SOURCE-MANIFEST.json'
    if material_manifest.exists():
        materials=release.read_json(material_manifest)
        if materials.get('schema')!='clw-preview-third-party-source-materials-v1' or materials.get('complete') is not True:
            raise SystemExit('third-party source material manifest is incomplete')
        whitelist=materials.get('distribution_files');artifacts=materials.get('artifacts');controls=materials.get('control_files')
        if not isinstance(whitelist,list) or not all(release.safe_name(n) for n in whitelist) or len(whitelist)!=len(set(n.casefold() for n in whitelist)) or controls!=['SOURCE-MANIFEST.json','SHA256SUMS.txt'] or not isinstance(artifacts,list):
            raise SystemExit('source materials whitelist invalid')
        actual={p.relative_to(source_directory).as_posix() for p in source_directory.rglob('*') if p.is_file()}
        artifact_names=set()
        for entry in artifacts:
            if not isinstance(entry,dict) or not release.safe_name(entry.get('file')) or entry['file'] in artifact_names:
                raise SystemExit('source material artifact entry invalid')
            artifact_names.add(entry['file'])
            if release.file_hash(release.plain(source_directory/entry['file'],source_directory))!={'sha256':entry.get('sha256'),'bytes':entry.get('bytes')}:
                raise SystemExit('source material artifact hash mismatch')
        if actual!=set(whitelist) or artifact_names|set(controls)!=set(whitelist):raise SystemExit('source materials files differ from exact whitelist')
        checksums={}
        for line in (source_directory/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
            if not line.strip():continue
            digest,name=line.split(None,1);name=name.strip().removeprefix('*')
            if not release.SHA.fullmatch(digest) or not release.safe_name(name) or name in checksums:raise SystemExit('source materials checksum inventory invalid')
            checksums[name]=digest
        if set(checksums)!=artifact_names|{'SOURCE-MANIFEST.json'}:raise SystemExit('source materials checksum inventory incomplete')
        if any(release.file_hash(source_directory/name)['sha256']!=digest for name,digest in checksums.items()):raise SystemExit('source materials checksum mismatch')
        result['source_materials_complete']=True
    elif require_sources:raise SystemExit('final distribution source manifest missing')
    for index,path in enumerate(sorted(source_directory.rglob('*'))):
        if path.is_dir():
            release.no_link_directory(path);continue
        path=release.plain(path,source_directory);relative=path.relative_to(source_directory).as_posix()
        if not release.safe_name(relative):raise SystemExit('source material filename invalid')
        frozen=release.file_hash(path);source_files.append(dict(file=relative,**frozen))
        temporary='clw-source-'+str(index)+'-'+path.name
        file_lines.append('Source: "'+str(path)+'"; DestName: "'+temporary+'"; Flags: dontcopy nocompression')
        target="ExpandConstant('{app}\\third-party-sources\\"+relative.replace('/','\\')+"')"
        code_lines.extend(["  ForceDirectories(ExtractFileDir("+target+"));",
            "  if FileExists("+target+") then begin",
            "    if GetSHA256OfFile("+target+") <> '"+frozen['sha256']+"' then RaiseException('Existing third-party source material differs; retained.');",
            '  end else begin',"    ExtractTemporaryFile('"+temporary+"');",
            "    if not FileCopy(ExpandConstant('{tmp}\\"+temporary+"'), "+target+", True) then RaiseException('Could not extract third-party source materials.');",
            "    if GetSHA256OfFile("+target+") <> '"+frozen['sha256']+"' then RaiseException('Extracted third-party source material hash differs.');",
            '  end;'])
code_lines.extend(['end;',''])
(stage/'source-files.iss').write_text('\n'.join(file_lines)+'\n',encoding='utf8')
(stage/'source-code.iss').write_text('\n'.join(code_lines),encoding='utf8')
result['source_materials']=source_files
(stage/'build-input.json').write_text(json.dumps(result,indent=2),encoding='utf8')
'@
$PreparePath=Join-Path $Stage 'prepare_installer.py'
[IO.File]::WriteAllText($PreparePath,$Prepare,[Text.UTF8Encoding]::new($false))
$PrepareArguments=@('-B',$PreparePath,$Root,$Archive,$Stage)
if ($SourceMaterialsDirectory) {
  $PrepareArguments+=(Resolve-Path -LiteralPath $SourceMaterialsDirectory).Path
  if ($RequireSourceMaterials) {$PrepareArguments+='required'} else {$PrepareArguments+='optional'}
}
& $PythonExecutable @PrepareArguments
if ($LASTEXITCODE -ne 0) {throw 'Preview archive preparation failed.'}
$Metadata=Get-Content -LiteralPath (Join-Path $Stage 'build-input.json') -Raw | ConvertFrom-Json
$BaseName='CLW-'+$Metadata.version+'-win-x64-setup'
$ArtifactDirectory=Join-Path $OutputDirectory $Metadata.build_id
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
$Executable=Join-Path $ArtifactDirectory ($BaseName+'.exe')
if (Test-Path -LiteralPath $Executable) {throw 'A built installer already exists for this build; choose a new output directory instead of replacing it.'}
$CompilerArguments=@('/Qp',('/DPayloadArchive='+$Archive),('/DBootstrapDirectory='+$Metadata.bootstrap),
  ('/DBuildVersion='+$Metadata.version),('/DPayloadSHA256='+$Metadata.archive_sha256),
  ('/DPreviewLicense='+(Join-Path $Stage 'PREVIEW-LICENSE.txt')),
  ('/DPreviewLaunchName='+$Metadata.launch_name),
  ('/DSourceFilesInclude='+(Join-Path $Stage 'source-files.iss')),('/DSourceCodeInclude='+(Join-Path $Stage 'source-code.iss')),
  ('/DOutputDirectory='+$ArtifactDirectory),('/DBuildFileName='+$BaseName),(Join-Path $Root 'packaging/preview.iss'))
if ($Metadata.lifecycle_result) {$CompilerArguments=@('/DHasLifecycleResult')+$CompilerArguments}
$CompilerTemp=Join-Path $Stage 'compiler-temp'
New-Item -ItemType Directory -Path $CompilerTemp | Out-Null
$PreviousTemp=$env:TEMP;$PreviousTmp=$env:TMP
try {
  $env:TEMP=$CompilerTemp;$env:TMP=$CompilerTemp
  & $InnoCompiler @CompilerArguments
  $CompilerExit=$LASTEXITCODE
} finally {$env:TEMP=$PreviousTemp;$env:TMP=$PreviousTmp}
if ($CompilerExit -ne 0) {throw 'Inno Setup compilation failed.'}
if ((Get-FileHash -LiteralPath $InnoCompiler -Algorithm SHA256).Hash.ToLowerInvariant() -ne $CompilerHash -or
    (Get-FileHash -LiteralPath $TemplatePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $TemplateHash -or
    (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BuilderHash) {throw 'Installer compiler or build sources changed during compilation.'}
if ($SourceMaterialsDirectory) {
  foreach ($SourceEntry in $Metadata.source_materials) {
    $SourcePath=Join-Path $SourceMaterialsDirectory $SourceEntry.file
    if ((Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $SourceEntry.sha256) {throw 'Source material changed during compilation.'}
  }
}
$Info=Get-Item -LiteralPath $Executable
$Receipt=@{schema=1;state='preview_installer_built';build_id=$Metadata.build_id;version=$Metadata.version;
  archive=$Archive;archive_sha256=$Metadata.archive_sha256;executable=$Executable;
  sha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$Info.Length;
  platform='windows-x64';signed=$false;per_user=$true;compiler=$InnoCompiler;build_stage=$Stage}
$Receipt.compiler_version=$CompilerVersion
$Receipt.compiler_sha256=$CompilerHash
$Receipt.installer_template_sha256=$TemplateHash
$Receipt.builder_script_sha256=$BuilderHash
$Receipt.source_materials=$Metadata.source_materials
$Receipt.source_materials_complete=$Metadata.source_materials_complete
$ReceiptPath=Join-Path $ArtifactDirectory ($BaseName+'.json')
$Receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
$Receipt | ConvertTo-Json -Depth 8
