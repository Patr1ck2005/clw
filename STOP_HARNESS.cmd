@echo off
setlocal
cd /d "%~dp0"
python -X utf8 -B scripts\harness_launcher.py stop
if errorlevel 1 pause
endlocal
