@echo off
rem Confluence Radar: starts the site on http://localhost:3000 and the 15-minute price check.
rem Double-click this file. Keep the window open (minimise it); closing it stops the site.
cd /d "%~dp0"
title Confluence Radar (keep this window open)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org , install it, then run this again.
  pause
  exit /b 1
)

if not exist ".env.local" copy ".env.example" ".env.local" >nul
findstr /r /c:"^GEMINI_API_KEY=[A-Za-z0-9]" /c:"^ANTHROPIC_API_KEY=[A-Za-z0-9]" ".env.local" >nul
if errorlevel 1 (
  echo.
  echo First run: fill in your settings in the Notepad window that opens
  echo ^(GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, and DATABASE_URL if it is still empty^), save it, close Notepad.
  echo See LOCAL-SETUP.txt for where to find each value.
  echo.
  notepad ".env.local"
  echo When you have saved .env.local and closed Notepad,
  pause
)

node scripts\local.mjs %*
echo.
echo Confluence Radar stopped. Look above or in logs\local.log for the reason.
pause
