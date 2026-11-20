@echo off
rem Copies the Confluence Radar database from PostgreSQL on this PC up to a new Neon database (for the site on Vercel).
rem Your local database and .env.local are not changed. See DEPLOY-VERCEL.txt.
cd /d "%~dp0"
title Confluence Radar - copy the database to Neon
node scripts\copy-db-to-neon.mjs
pause
