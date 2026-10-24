@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-scanner.ps1"
if errorlevel 1 (
  echo.
  echo Bybit Scanner failed to start. See the error above.
  pause
  exit /b 1
)
endlocal
