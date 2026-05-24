@echo off
setlocal
cd /d "%~dp0"

echo Starting RemoteDesk Host...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remotedesk_host.ps1"
echo.
echo RemoteDesk Host stopped.
pause
endlocal
