@echo off
setlocal
cd /d "%~dp0"
"D:\Program Files\Python311\python.exe" -B "%~dp0scripts\host_process.py" start workspace
set "RESULT=%ERRORLEVEL%"
echo.
echo See START_HERE.html for setup status.
pause
exit /b %RESULT%
