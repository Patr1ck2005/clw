@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
 echo Python 3.11 or newer is required. Nothing was installed or changed.
 pause
 exit /b 1
)
echo CLW Harness - native Web plus local Codex
echo This terminal owns only the local panel. Keep it open while working.
python -X utf8 -B scripts\harness_launcher.py run --open
if errorlevel 1 pause
endlocal
