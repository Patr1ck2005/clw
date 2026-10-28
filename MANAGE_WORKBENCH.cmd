@echo off
setlocal
cd /d "%~dp0"
python -B scripts\workbench_release.py manage
pause
