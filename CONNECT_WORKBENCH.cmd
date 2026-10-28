@echo off
setlocal
cd /d "%~dp0"
python -B scripts\workbench_release.py start --bootstrap --connect --open
if errorlevel 1 pause
