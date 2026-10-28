@echo off
setlocal
cd /d "%~dp0"
python -B scripts\workbench_release.py start --bootstrap --open
if errorlevel 1 pause
