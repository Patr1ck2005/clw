; Unsigned, per-user preview. Build with scripts/build_preview_installer.ps1.
#ifndef PayloadArchive
  #error PayloadArchive is required
#endif
#ifndef BootstrapDirectory
  #error BootstrapDirectory is required
#endif
#ifndef BuildVersion
  #error BuildVersion is required
#endif
#ifndef PayloadSHA256
  #error PayloadSHA256 is required
#endif

[Setup]
AppId={{14A9B536-7367-47FD-A990-0A3F58F3571A}
AppName=CLW Preview
AppVersion={#BuildVersion}
AppPublisher=CLW
AppCopyright=Copyright CLW. All rights reserved.
LicenseFile={#PreviewLicense}
DefaultDirName={localappdata}\CLW Preview
DefaultGroupName=CLW Preview
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; This per-user installation deliberately links verified code to its own data.
; On the tested Windows build, Inno's guard also reaches the lifecycle child
; and blocks this junction. The lifecycle keeps its exact target/owner/hash gates.
RedirectionGuard=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDirectory}
OutputBaseFilename={#BuildFileName}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
UninstallFilesDir={app}\installer
UninstallDisplayName=CLW Preview (data and Jobs retained)
CloseApplications=no
RestartApplications=no
SetupLogging=yes
SignedUninstaller=no
AllowNoIcons=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
Name: sources; Description: "Extract the included third-party source and rebuild materials"; Flags: unchecked

[Files]
Source: "{#PayloadArchive}"; DestDir: "{tmp}"; DestName: "clw-preview-payload.zip"; Flags: deleteafterinstall nocompression
Source: "{#BootstrapDirectory}\*"; DestDir: "{app}\installer\bootstrap"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef SourceFilesInclude
  #include SourceFilesInclude
#endif

[Icons]
Name: "{group}\CLW Preview"; Filename: "{app}\{#PreviewLaunchName}"; WorkingDir: "{app}"
Name: "{group}\CLW Maintenance"; Filename: "{app}\MAINTENANCE.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\CLW Preview"; Filename: "{app}\{#PreviewLaunchName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Code]
var
  LifecycleFailed: Boolean;

#ifdef SourceCodeInclude
  #include SourceCodeInclude
#else
procedure ExtractSourceMaterials;
begin
end;
#endif
function InstallerPython: String;
begin
  Result := ExpandConstant('{app}\installer\bootstrap\runtime\python\python.exe');
end;

function LifecycleArgs(Action: String): String;
begin
  Result := '-B "' + ExpandConstant('{app}\installer\bootstrap\scripts\preview_installer.py') +
    '" ' + Action + ' --install-root "' + ExpandConstant('{app}') + '"';
  #ifdef HasLifecycleResult
  if Action <> 'guard' then
    Result := Result + ' --result-file "' + ExpandConstant('{tmp}\clw-preview-') + Action + '-result.json"';
  #endif
end;

procedure LogLifecycleResult(Action: String);
var
  Value: AnsiString;
begin
  if LoadStringFromFile(ExpandConstant('{tmp}\clw-preview-') + Action + '-result.json', Value) then
    Log('CLW lifecycle result: ' + String(Value));
end;

function GetCustomSetupExitCode: Integer;
begin
  if LifecycleFailed then Result := 120 else Result := 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\installation.json')) then begin
    if not FileExists(InstallerPython) then begin
      { A completed uninstall retains data/identity but removes its bootstrap.
        The new bootstrap still verifies that identity and ownership before any
        version is selected; a live independent native owner is never stopped. }
      if (not FileExists(ExpandConstant('{app}\active.json'))) and
          FileExists(ExpandConstant('{app}\uninstall-retained.json')) then
        exit;
      Result := 'The existing installation is incomplete. Its data has been retained.';
      exit;
    end;
    if (not Exec(InstallerPython, LifecycleArgs('guard'), '', SW_HIDE, ewWaitUntilTerminated, Code)) or (Code <> 0) then
      Result := 'CLW or a retained Job is still using this installation, or its ownership could not be verified. Close CLW normally and retry. No process was stopped.';
  end else if DirExists(ExpandConstant('{app}')) and
      (FileExists(ExpandConstant('{app}\active.json')) or DirExists(ExpandConstant('{app}\data'))) then
    Result := 'This folder contains unrecognized data. Choose a new empty installation folder.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Args: String;
begin
  if CurStep = ssPostInstall then begin
    LifecycleFailed := True;
    Args := LifecycleArgs('install') + ' --inno-layout --archive "' +
      ExpandConstant('{tmp}\clw-preview-payload.zip') + '" --sha256 {#PayloadSHA256}';
    Code := -1;
    if not Exec(InstallerPython, Args, '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := -1;
    Log('CLW lifecycle process exit: ' + IntToStr(Code));
    LogLifecycleResult('install');
    if Code <> 0 then
      RaiseException('The preview payload could not be verified or selected. Existing data and Jobs were retained. See the setup log.');
    ExtractSourceMaterials;
    LifecycleFailed := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    Code := -1;
    if not Exec(InstallerPython, LifecycleArgs('uninstall'), '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := -1;
    LogLifecycleResult('uninstall');
    { Inno 6.7.3 runs this event before PerformUninstall and propagates its
      exception. Retain registration/bootstrap when ownership is still busy. }
    if Code <> 0 then
      RaiseException('CLW is still open, or application ownership could not be verified. Close CLW normally and retry uninstall. No process was stopped; data, Jobs, and the installer were retained.');
  end;
end;
