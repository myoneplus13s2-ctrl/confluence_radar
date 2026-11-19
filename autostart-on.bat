@echo off
rem Makes Confluence Radar start by itself (minimised) every time you sign in to Windows.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\Confluence Radar.bat" (
  echo @echo off
  echo start "Confluence Radar" /min "%~dp0start-local.bat"
)
echo Done. Confluence Radar will now start by itself when you sign in to Windows.
echo To undo this, run autostart-off.bat.
pause
