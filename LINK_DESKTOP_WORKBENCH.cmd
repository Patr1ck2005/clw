@echo off
setlocal
cd /d "%~dp0"
python -B scripts\workbench_release.py start --bootstrap --choose-runner-config --open
if errorlevel 1 pause
