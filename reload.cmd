@echo off
rem TV Mode: close Steam, rebuild the plugin, reopen straight into Big Picture.
echo Closing Steam...
taskkill /f /im steam.exe >nul 2>&1
timeout /t 3 /nobreak >nul
cd /d "%~dp0"
echo Building TV Mode...
call "%USERPROFILE%\.bun\bin\bun.exe" run build
if errorlevel 1 (
  echo Build failed - Steam not restarted.
  pause
  exit /b 1
)
echo Starting Steam in Big Picture...
start "" "steam://open/bigpicture"
