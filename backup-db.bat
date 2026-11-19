@echo off
rem Backs up the Confluence Radar database now, into Google Drive for desktop's "My Drive\Confluence Radar backups"
rem (or logs\backups when Google Drive for desktop is not installed). See LOCAL-SETUP.txt, section 8.
cd /d "%~dp0"
title Confluence Radar - backup
node scripts\backup-db.mjs
pause
