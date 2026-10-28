@echo off
setlocal
cd /d "%~dp0"
if not exist "apps\web-host\node_modules\electron\dist\electron.exe" (
 echo CLW browser dependencies are missing. See docs\harness\MANAGED_WEB.md.
 exit /b 1
)
where pythonw >nul 2>nul
if errorlevel 1 (
 echo Python 3.11 or newer is required.
 exit /b 1
)
start "CLW Web Workspace" pythonw "%~dp0scripts\web_host_launcher.py"
endlocal
