@echo off
setlocal

cd /d "%~dp0"

echo.
echo === REPM5 Study Manager - Local Dev ===
echo Project: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not available in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or not available in PATH.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo .env.local was not found.
  echo Create .env.local first, or copy values from .env.example.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Checking port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Port 3000 is already in use by PID %%a. Stopping it...
  taskkill /PID %%a /F >nul 2>nul
)

echo.
echo Opening http://localhost:3000
start "" "http://localhost:3000"
echo.
echo Other devices on the same Wi-Fi/LAN can open one of these URLs:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { '  http://' + $_.IPAddress + ':3000' }"
echo.
echo If Windows Firewall asks, allow access on Private networks.
echo.
echo Starting Next.js dev server on 0.0.0.0:3000...
echo Press Ctrl+C in this window to stop.
echo.

call npm run dev -- -H 0.0.0.0 -p 3000

pause
