@echo off
setlocal
cd /d "%~dp0"
fltmc >nul 2>&1
if errorlevel 1 (
  echo This maintenance writes the installed WebCodex runtime and needs Windows administrator approval before any task is armed.
  powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/c','""%~f0""' -Verb RunAs"
  if errorlevel 1 (
    echo Administrator relaunch was not accepted. No maintenance operation was started.
    pause
    exit /b 1
  )
  exit /b 0
)
python -X utf8 -B scripts/native_maintenance.py assist --stage "%~dp0.local\native-maintenance\existing-ab-37098d4624f0"
if errorlevel 1 pause
