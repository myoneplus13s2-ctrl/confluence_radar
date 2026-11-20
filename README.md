# Confluence Radar

Upload hourly screenshots of two TradingView screeners and get a searchable history of every signal, plus a tracker that tells you when a Gold signal is followed by a same-direction BOS or CHoCH.

- **Divergence screener** ("My MTF Screener v6"): G🔥 Gold Buy, G❄ Gold Sell, V↑/V↓ VMC divergences, R↑/R↓ RSI divergences.
- **BOS/CHoCH screener** ("SMC Multi-Symbol Screener"): Int/Sw BOS↑↓ and Int/Sw CHoCH↑↓.

## How it works

1. Drop, choose or paste screenshots. A vision model (Google Gemini's free tier by default, or Claude) reads each table cell by cell; the app then parses the labels and dates itself.
2. Every signal is stored once per symbol, timeframe, signal type and time. Symbols are never removed: when a symbol drops out of the screener its history stays, and newer screenshots add new signals to it.
3. Tabs:
   - **Gold → BOS/CHoCH**: every Gold signal with the BOS/CHoCH that followed it on the same symbol in the same direction (G🔥 → bullish, G❄ → bearish), within the window for the Gold signal's timeframe: 15m → 2 days, 1h → 7 days, 4h → 14 days, 1D → 21 days. Status is *confirmed*, *watching* (window still open) or *expired*. The structure signal can be on any timeframe; tick "same timeframe" to require a match.
   - **Signals**: filter by signal type, timeframe, age (e.g. G🔥 in the last 24 hours, the screener's ⚡ window) and symbol.
   - **Symbols**: the latest signal of each kind for every symbol and timeframe.
   - **Uploads**: every screenshot processed, its warnings, and a delete button for a bad read.
   - **Gold → Fib**: every Gold signal on a symbol you have fibs for, and whether price reached a matching fib (see below).
   - **Trends**: the trend of each tracked symbol on 15m, 1H, 4H and 1D.
   - **My fibs**: the fibs you drew in TradingView.
   - **Telegram**: alert setup and which signals to send.

## Trends, fibs and Telegram alerts

A check runs every 15 minutes (on Vercel: GitHub Actions, `.github/workflows/tick.yml`, once the `RADAR_URL` repository variable is set; on your PC: `start-local.bat`) and after every upload. It needs no TradingView access: prices come from Bitget's public market data (the screeners run on `BITGET:…USDT.P`).

- **Trend** per timeframe from confirmed swing highs and lows (5 bars either side): higher high + higher low is an uptrend, lower high + lower low a downtrend. Once a trend is set, a higher high in a downtrend (or a lower low in an uptrend), or price going past the last swing before it confirms, is a *potential change*. Symbols with a signal in the last 7 days, or an active fib, are tracked.
- **Fibs** are entered on the My fibs tab: symbol, 1H or 4H, green (bullish retest) or red (bearish retest), and the swing high and low. Levels are 0.5, 0.618 and 0.786. TradingView has no way to export drawings, so they are copied by hand.
- **Gold → Fib**: after a Gold Buy the check watches the symbol's green fibs (red for Gold Sell), within the Gold signal's window, on 15m candles. The first touch of a level (within the tolerance on the Telegram tab, 0.15% by default) is recorded; *at fib* means price was already there on the Gold bar. A same-direction BOS/CHoCH whose bar closes after the touch makes it the stronger signal.
- **Telegram**: create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` in Vercel, send the bot a message, then press *Find my chat* on the Telegram tab. Only events from the last 3 hours are sent, and each one once.

Setup for the scheduled check: if `APP_PASSWORD` is set, add a `CRON_SECRET` (any long random string) in Vercel and the same value as a GitHub repository secret named `CRON_SECRET`. The `/api/tick` route runs in Vercel's Singapore region (`sin1`) because Bitget refuses some US addresses.

### Timezones

The cell times have no year or timezone, so the upload box asks which offset each screener prints in. The samples show the divergence screener in IST (UTC+05:30) and the BOS/CHoCH screener in UTC, which are the defaults. The snapshot time is read from TradingView's header ("Oct 25, 2026 16:00 UTC+5:30") and decides the year. If a signal comes out later than the snapshot, the upload shows a warning that the timezone setting is probably wrong.

### Limits

The BOS/CHoCH screener only shows the latest event per cell, so if two structure breaks print between screenshots, only the second is seen. Hourly uploads keep that gap small.

## Run on your own PC (Windows)

See [LOCAL-SETUP.txt](LOCAL-SETUP.txt). In short: double-click `start-local.bat`, fill in `.env.local` the first time, and open http://localhost:3000. `scripts/local.mjs` installs and builds when needed, runs `next start`, POSTs `/api/tick` every 15 minutes (replacing the GitHub Actions schedule, which is now off), and restarts the server if it stops. `autostart-on.bat` starts it at Windows sign-in. `move-db-to-pc.bat` (`scripts/move-db.mjs`) copies the Neon database into a local PostgreSQL with `pg_dump`/`pg_restore`, checks the signal count, and switches `DATABASE_URL`. `backup-db.bat` (`scripts/backup-db.mjs`) dumps the database into Google Drive for desktop's `My Drive\Confluence Radar backups` (or `BACKUP_DIR`, else `logs/backups`), keeps 14, and `local.mjs` runs it daily. Point the capture script at it with `"site": "http://localhost:3000"` in `capture/config.json` (or the `RADAR_URL` environment variable).

## Deploy on Vercel

Step by step, including copying the data from the PC copy to a new Neon database: [DEPLOY-VERCEL.txt](DEPLOY-VERCEL.txt) (`copy-db-to-neon.bat` runs `scripts/copy-db-to-neon.mjs`, `pg_dump` from the local database and `pg_restore` into Neon). In short:

1. Import this repository in Vercel. `vercel.json` runs all functions in Singapore (`sin1`): Bitget refuses some US addresses, and the database should be in the same region (Neon: AWS Asia Pacific, Singapore).
2. Create a **Neon** database (Singapore) and set `DATABASE_URL` to its pooled connection string. Tables are created on first use.
3. Settings → Environment Variables:
   - `GEMINI_API_KEY`: free key from https://aistudio.google.com/apikey (no card needed). Free-tier limits are far above 2 screenshots an hour. Google may use free-tier inputs to improve its products.
   - `APP_PASSWORD` (recommended): the site then asks for a password (any username). Without it anyone with the URL can use up your Gemini quota.
   - Optional: `GEMINI_MODEL` (default `gemini-3.8-flash`). When a model is busy or retired the app moves on to other Flash models, including the replacement Google names in its error.
   - For alerts: `TELEGRAM_BOT_TOKEN`, and `CRON_SECRET` when `APP_PASSWORD` is set (see below). Optional: `TELEGRAM_CHAT_ID`, `ALERT_TZ` (default `Asia/Kolkata`).
   - Optional, paid instead of Gemini: `ANTHROPIC_API_KEY` with `EXTRACTION_MODEL` (default `claude-opus-5-5`) and `EXTRACTION_EFFORT`. Used only when `GEMINI_API_KEY` is not set.
4. Redeploy.
5. GitHub → Settings → Secrets and variables → Actions → Variables: `RADAR_URL` = the site's address. This turns on the 15-minute check.

### Keeping CPU and database use low

Vercel's free plan limits function CPU time, and Neon's free plan limits how long the database is awake (it sleeps after 5 minutes without queries). So:

- **Page data is cached** (`lib/cache.ts`, Next.js data cache). Reading a tab, or the alarm's once-a-minute check, doesn't touch the database until something changes; every write (the check, uploads, edits on the site) clears the cache. Between checks the database can sleep even with the site open.
- **One fetch per symbol and timeframe per check** (`shareCandles`/`planCandles` in `lib/market.ts`): trends, fibs and the oscillator share the candles, fetched at the longest length any step needs.
- **Batched writes**: trends, fibs, fib-level hits and fib runs are written with one statement each instead of one per row, the BOS/CHoCH-after-fib step reads its candidates in one query, and Telegram messages (with their trend line) are only built when they will be sent. A steady check makes about 30 queries instead of ~1,500 with 60 symbols.
- **Gold → fib touches are read incrementally** (`fib_touch_checks`): each pair remembers how far it was checked, so a check reads the last few 15m candles instead of up to 21 days of them. A pair is read again from the Gold signal when the fib's ends or the tolerance change, so the result is the same.
- **Light check after uploads**: trends refreshed by the scheduled check under 10 minutes ago are kept (new symbols still get theirs).

`DATABASE_URL=postgres://... npx tsx scripts/bench-tick.ts 60` runs the check against a fake Bitget with 60 symbols and prints CPU time, queries and Bitget calls per run (it drops the tables in that database).

## Text uploads

Signals can also be pasted as plain text, one per line, with no AI on the server. See [docs/text-format.md](docs/text-format.md) for the format and a prompt that makes the Gemini app produce it from a screenshot.

## Automatic hourly capture

See [capture/README.md](capture/README.md): a GitHub Actions job (or a script on your computer) that screenshots your TradingView layouts every hour and uploads them. Works with free TradingView accounts.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL and GEMINI_API_KEY
npm run dev
DATABASE_URL=postgres://... npm test   # drops and recreates the tables in that database
```
