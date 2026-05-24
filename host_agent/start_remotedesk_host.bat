@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher was not found.
  echo Install Python 3 from https://www.python.org/downloads/ and run this file again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating RemoteDesk Host environment...
  py -m venv .venv
  if errorlevel 1 (
    echo Failed to create the Python environment.
    pause
    exit /b 1
  )
)

echo Installing required packages...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Failed to install requirements.
  pause
  exit /b 1
)

echo Starting RemoteDesk Host...
".venv\Scripts\python.exe" remotedesk_host.py
endlocal
