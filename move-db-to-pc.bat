@echo off
rem Copies the Confluence Radar database from Neon into PostgreSQL on this PC, then makes the site use it.
rem Install PostgreSQL first: https://www.postgresql.org/download/windows/  (see LOCAL-SETUP.txt, section 7)
cd /d "%~dp0"
title Confluence Radar - move the database to this PC
node scripts\move-db.mjs
pause
