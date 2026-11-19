@echo off
rem Stops Confluence Radar from starting by itself when you sign in to Windows.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Confluence Radar.bat" >nul 2>nul
echo Done. Confluence Radar will no longer start by itself. Use start-local.bat to start it.
pause
