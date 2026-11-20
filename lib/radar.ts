// The periodic check: refreshes trends and the auto fibs from live candles, records every fib level price reaches,
// looks for Gold signals reaching a matching fib (and a BOS/CHoCH after that), and sends the Telegram digest.
import type postgres from "postgres";
import { AUTO_FIB_TFS, legFibs } from "./autofib";
import { eightHourFrom4h, storedCandles, weeklyFromDaily } from "./candle-store";
import { fibLevels, firstTouch, type Fib } from "./fibs";
import { candlesSince, planCandles, recentCandles, shareCandles, TF_MS } from "./market";
import { GOLD_WINDOW_DAYS, SIGNAL_BY_CODE } from "./signals";
import { findLevelHits, sendDigest } from "./digest";
import { checkStale } from "./health";
import { checkOscillator, oscDue } from "./osc-check";
import { checkPriceAlerts, sendPriceAlerts } from "./price-alerts";
import { alertSettings, esc, sendTelegram, telegramReady, type AlertSettings } from "./telegram";
import { analyzeTrend, fmtPrice, type Candle } from "./trend";

export const TREND_TFS = ["15m", "1h", "4h", "1D"];
const WEEKLY_DAYS = 2100; // daily candles kept per symbol: 300 weeks for the 1W structure
const TRACK_DAYS = 7; // symbols with a signal in this many days get trends
const ALERT_MAX_AGE_MS = 3 * 3600_000; // older events are recorded but not sent, so a first run doesn't flood the chat
const ALERT_TZ = process.env.ALERT_TZ || "Asia/Kolkata";

export interface TickSummary {
  symbols: number;
  trendsUpdated: number;
  fibsRedrawn: number; // symbol and timeframe pairs whose auto fibs were worked out again
  levelHits: number; // fib levels price reached since the last run
  priceAlerts: number; // the user's own alerts that price reached
  oscChecked: number; // symbol and timeframe pairs whose Prime Oscillator was worked out after a new close
  manualFibsRemoved: number; // fibs entered by hand that price closed beyond
  fibHits: number;
  structureAfterFib: number;
  alertsSent: number;
  errors: string[];
  ms: number;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

const tfLabel = (tf: string) => tf.replace(/h$/, "H");
const arrow = (t: string | null) => (t === "up" || t === "bull" ? "↑" : t === "down" || t === "bear" ? "↓" : "↔");

let whenFormat: Intl.DateTimeFormat | null = null; // making one is slow, so it's made once
function when(t: Date | number | string): string {
  whenFormat ??= new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ALERT_TZ,
  });
  const s = whenFormat.format(new Date(t));
  return `${s} ${ALERT_TZ === "Asia/Kolkata" ? "IST" : ALERT_TZ}`;
}

const recent = (...times: Array<Date | number | string | null | undefined>) =>
  times.some((t) => t != null && Date.now() - new Date(t).getTime() < ALERT_MAX_AGE_MS);

export interface TickOptions {
  // Run right after an upload: when the last check refreshed the trends under 10 minutes ago, only symbols without
  // any trend yet get theirs (the next scheduled check refreshes the rest). Everything else runs as usual.
  light?: boolean;
}

export async function tick(sql: postgres.Sql, opts: TickOptions = {}): Promise<TickSummary> {
  const stopSharing = shareCandles();
  try {
    return await runTick(sql, opts);
  } finally {
    stopSharing();
  }
}

async function runTick(sql: postgres.Sql, opts: TickOptions): Promise<TickSummary> {
  const started = Date.now();
  const settings = await alertSettings(sql);
  const errors: string[] = [];
  let alertsSent = 0, priceAlerts = 0, oscChecked = 0, trendsUpdated = 0, fibsRedrawn = 0, levelHits = 0, manualFibsRemoved = 0, fibHits = 0, structureAfterFib = 0;

  // Alerts already sent recently: skipped without a query or building the message. The insert below still decides.
  const sentKeys = new Set(telegramReady()
    ? (await sql`SELECT key FROM alerts WHERE sent_at > now() - interval '30 days'`).map((r) => r.key as string) : []);
  const alert = async (enabled: boolean, key: string, message: string | (() => Promise<string>), isRecent: boolean) => {
    if (!enabled || !isRecent || !telegramReady() || sentKeys.has(key)) return;
    const html = typeof message === "string" ? message : await message();
    const [row] = await sql`INSERT INTO alerts (key, text) VALUES (${key}, ${html}) ON CONFLICT DO NOTHING RETURNING key`;
    if (!row) return;
    try {
      await sendTelegram(sql, html);
      alertsSent++;
    } catch (e) {
      await sql`DELETE FROM alerts WHERE key = ${key}`; // try again on the next run
      errors.push(e instanceof Error ? e.message : String(e));
    }
  };

  // ── The user's own price alerts: first, so a slow run doesn't hold them up ──
  try {
    priceAlerts = await checkPriceAlerts(sql, errors);
    alertsSent += await sendPriceAlerts(sql, settings, errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Trends ──
  // Watchlist symbols first, so a symbol just added gets its trends, fibs and oscillator in the next run.
  const symbols = [...new Set((await sql`
    SELECT symbol, 0 AS k FROM watchlist
    UNION SELECT symbol, 1 FROM signals WHERE signal_time > now() - make_interval(days => ${TRACK_DAYS})
    UNION SELECT symbol, 1 FROM fibs WHERE active AND source = 'manual'
    ORDER BY k, symbol`).map((r) => r.symbol as string))];
  const previous = new Map<string, postgres.Row>();
  for (const r of await sql`SELECT * FROM trends`) previous.set(`${r.symbol}|${r.tf}`, r);
  const trendsFresh = opts.light && [...previous.values()].some((r) => Date.now() - new Date(r.updated_at).getTime() < 10 * 60_000);

  // What the later steps will fetch, so each symbol and timeframe is fetched once at the longest length needed
  const lastRun = new Map<string, number>();
  for (const r of await sql`SELECT * FROM fib_runs`) lastRun.set(`${r.symbol}|${r.tf}`, new Date(r.last_closed).getTime());
  const due = symbols.flatMap((s) => AUTO_FIB_TFS.map((tf) => [s, tf] as const)).filter(([s, tf]) => {
    const last = lastRun.get(`${s}|${tf}`);
    return last == null || Date.now() >= last + 2 * TF_MS[tf]; // the candle after the last closed one has closed
  });
  const osc = await oscDue(sql, symbols);
  const hasTrend = new Set([...previous.values()].map((r) => r.symbol as string));
  const trendSymbols = trendsFresh ? symbols.filter((s) => !hasTrend.has(s)) : symbols;
  for (const s of trendSymbols) for (const tf of TREND_TFS) planCandles(s, tf, 300);
  for (const [s, tf] of due) planCandles(s, tf === "8h" ? "4h" : tf === "1W" ? "1D" : tf, 1000);
  for (const [s, tf] of osc.due) planCandles(s, tf, 1000);

  const trendRows: Array<Record<string, unknown>> = [];
  await pool(trendSymbols.flatMap((s) => TREND_TFS.map((tf) => [s, tf] as const)), 4, async ([symbol, tf]) => {
    let candles: Candle[];
    try {
      candles = await recentCandles(symbol, tf, 300);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    if (candles.length < 20) return;
    const r = analyzeTrend(candles);
    trendRows.push({
      symbol, tf, trend: r.trend, potential: r.potential, since: r.since ? new Date(r.since) : null,
      last_high: r.lastHigh ? sql.json({ ...r.lastHigh }) : null, last_low: r.lastLow ? sql.json({ ...r.lastLow }) : null,
      price: r.price, note: r.note || null,
    });
    trendsUpdated++;
    const prev = previous.get(`${symbol}|${tf}`);
    if (!prev || !settings.trendTfs.includes(tf)) return; // first sighting: nothing to compare with
    if (r.trend !== prev.trend && r.trend !== "range") {
      await alert(settings.trendChange, `trend:${symbol}:${tf}:${r.trend}:${r.since}`,
        `${arrow(r.trend)} <b>${esc(symbol)} ${tfLabel(tf)}</b> is now in an <b>${r.trend}trend</b> (was ${prev.trend}). Price ${fmtPrice(r.price)}`, true);
    }
    if (r.potential && r.potential !== prev.potential) {
      const swing = r.potential === "up" ? r.lastHigh : r.lastLow;
      await alert(settings.trendPotential, `potential:${symbol}:${tf}:${r.potential}:${swing?.t}`,
        `⚠️ <b>${esc(symbol)} ${tfLabel(tf)}</b> potential trend change ${arrow(r.potential)}: ${esc(r.note)}. Price ${fmtPrice(r.price)}`, true);
    }
  });
  // All trends in one statement instead of one per symbol and timeframe
  for (let i = 0; i < trendRows.length; i += 500) {
    await sql`
      INSERT INTO trends ${sql(trendRows.slice(i, i + 500) as never, "symbol", "tf", "trend", "potential", "since", "last_high", "last_low", "price", "note")}
      ON CONFLICT (symbol, tf) DO UPDATE SET trend = EXCLUDED.trend, potential = EXCLUDED.potential,
        since = EXCLUDED.since, last_high = EXCLUDED.last_high, last_low = EXCLUDED.last_low,
        price = EXCLUDED.price, note = EXCLUDED.note, updated_at = now()`;
  }

  const trendLine = async (symbol: string) => {
    const rows = await sql`SELECT tf, trend, potential FROM trends WHERE symbol = ${symbol}`;
    const by = new Map(rows.map((r) => [r.tf as string, r]));
    return TREND_TFS.map((tf) => {
      const r = by.get(tf);
      return `${tfLabel(tf)} ${r ? arrow(r.trend) + (r.potential ? `(→${arrow(r.potential)})` : "") : "?"}`;
    }).join(" · ");
  };

  // ── Fibs from each timeframe's swing structure, redone after each new candle close (`due`, worked out above) ──
  const drawFibs = async ([symbol, tf]: readonly [string, string]) => {
    let candles: Candle[];
    try {
      if (["5m", "15m", "1h", "2h"].includes(tf)) candles = (await recentCandles(symbol, tf, 1000)).slice(0, -1); // the last one is still forming
      else {
        // Bitget serves about 90 days per call, so these are built up over a few runs; 1W comes from the daily
        // candles and 8H from the 4H ones.
        const base = tf === "4h" || tf === "8h" ? "4h" : "1D";
        const got = await storedCandles(sql, symbol, base, base === "4h" ? 1000 : WEEKLY_DAYS, tf === "1W" || tf === "8h" ? 0 : 8);
        if (!got.complete) return; // older history still coming: draw once it's all there
        candles = tf === "1W" ? weeklyFromDaily(got.candles) : tf === "8h" ? eightHourFrom4h(got.candles)
          : tf === "1D" ? got.candles.slice(-1000) : got.candles;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!candles.length) return;
    const legs = legFibs(candles).map((f) => ({
      symbol, tf, direction: f.direction, high: f.high, low: f.low, source: "auto", anchor_t: new Date(f.anchorT),
      high_t: new Date(f.highT), low_t: new Date(f.lowT), forming: f.forming,
    }));
    // All of this symbol and timeframe's legs in one statement (legFibs keeps one leg per direction and start)
    const ids: number[] = legs.length ? (await sql`
      INSERT INTO fibs ${sql(legs, "symbol", "tf", "direction", "high", "low", "source", "anchor_t", "high_t", "low_t", "forming")}
      ON CONFLICT (symbol, tf, direction, anchor_t) WHERE source = 'auto' DO UPDATE SET high = EXCLUDED.high,
        low = EXCLUDED.low, high_t = EXCLUDED.high_t, low_t = EXCLUDED.low_t, forming = EXCLUDED.forming,
        active = true, ended_at = NULL
      RETURNING id`).map((r) => r.id as number) : [];
    drawn.push({ key: `${symbol}|${tf}`, ids, symbol, tf, last_closed: new Date(candles[candles.length - 1].t) });
    fibsRedrawn++;
  };
  const drawn: Array<{ key: string; ids: number[]; symbol: string; tf: string; last_closed: Date }> = [];
  // 1W and 8H are built from the daily and 4H candles, so they go after 1D and 4H have fetched them
  const derived = (tf: string) => tf === "1W" || tf === "8h";
  await pool(due.filter(([, tf]) => !derived(tf)), 4, drawFibs);
  await pool(due.filter(([, tf]) => derived(tf)), 4, drawFibs);
  if (drawn.length) {
    // Price has closed beyond them since, or a later leg took over: every redrawn timeframe's other auto fibs end
    const kept = drawn.flatMap((d) => d.ids);
    await sql`
      UPDATE fibs SET active = false, forming = false, ended_at = now()
      WHERE source = 'auto' AND active AND symbol || '|' || tf IN ${sql(drawn.map((d) => d.key))}
        ${kept.length ? sql`AND id NOT IN ${sql(kept)}` : sql``}`;
    await sql`
      INSERT INTO fib_runs ${sql(drawn as never, "symbol", "tf", "last_closed")}
      ON CONFLICT (symbol, tf) DO UPDATE SET last_closed = EXCLUDED.last_closed`;
  }
  // 5m and 15m fibs come and go every few runs: drop the broken ones after 3 days so they don't pile up
  await sql`DELETE FROM fibs WHERE source = 'auto' AND tf IN ('5m', '15m') AND NOT active AND ended_at < now() - interval '3 days'`;

  // ── Fibs entered by hand go once a candle on their timeframe closes beyond the swing they start from (below a
  // green fib's low, above a red fib's high), counting candles that closed after the fib was added ──
  const manual = (await sql`
    SELECT id, symbol, tf, direction, high, low, created_at FROM fibs WHERE source = 'manual' AND active`) as unknown as Array<
    Fib & { created_at: Date }>;
  const manualBy = new Map<string, typeof manual>();
  for (const f of manual) manualBy.set(`${f.symbol}|${f.tf}`, [...(manualBy.get(`${f.symbol}|${f.tf}`) ?? []), f]);
  await pool([...manualBy.values()], 4, async (list) => {
    const { symbol, tf } = list[0];
    const ms = TF_MS[tf];
    if (!ms) return;
    const since = Math.min(...list.map((f) => new Date(f.created_at).getTime()));
    let candles: Candle[];
    try {
      candles = await recentCandles(symbol, tf, Math.min(1000, Math.ceil((Date.now() - since) / ms) + 2));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const f of list) {
      const added = new Date(f.created_at).getTime();
      const broken = candles.some((c) => c.t + ms > added && c.t + ms <= Date.now() &&
        (f.direction === "bull" ? c.c < Number(f.low) : c.c > Number(f.high)));
      if (broken) {
        await sql`DELETE FROM fibs WHERE id = ${f.id}`;
        manualFibsRemoved++;
      }
    }
  });

  // ── Prime Oscillator above +level / below -level on 1H, 2H, 4H, 1D ──
  try {
    oscChecked = await checkOscillator(sql, symbols, settings.oscLevel, errors, osc);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Every fib level price reached ──
  try {
    levelHits = await findLevelHits(sql, settings.fibTolerancePct, errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Gold signals reaching a matching fib ──
  const windowCase = sql.unsafe(
    "CASE g.tf " + Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") + " END",
  );
  const fibs = (await sql`SELECT * FROM fibs WHERE active`) as unknown as Array<Fib & { note: string | null }>;
  const fibName = (f: { tf: string; direction: string; source?: string; forming?: boolean; high: number; low: number }) =>
    `${tfLabel(f.tf)} ${f.direction === "bull" ? "🟢 green" : "🔴 red"} fib` +
    (f.source === "auto" ? ` (${f.direction === "bull" ? `${fmtPrice(f.low)} → ${fmtPrice(f.high)}` : `${fmtPrice(f.high)} → ${fmtPrice(f.low)}`}${f.forming ? ", leg still forming" : ""})` : "");
  const golds = await sql`
    SELECT g.*, g.signal_time + ${windowCase} AS window_end FROM signals g
    WHERE g.family = 'gold' AND g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}
      AND g.signal_time + ${windowCase} > now() - interval '1 hour'
      AND g.symbol IN (SELECT symbol FROM fibs WHERE active)`;
  const goldIds = golds.map((g) => g.id as number);
  const done = new Set(goldIds.length
    ? (await sql`SELECT gold_id, fib_id FROM fib_hits WHERE gold_id IN ${sql(goldIds)}`).map((r) => `${r.gold_id}|${r.fib_id}`) : []);
  // How far each pair was already checked. A pair is read again from its Gold signal when the fib's ends (a forming
  // leg) or the tolerance changed since, so the result is the same as reading from the Gold signal every time.
  const checked = new Map<string, number>();
  if (goldIds.length) {
    for (const r of await sql`SELECT * FROM fib_touch_checks WHERE gold_id IN ${sql(goldIds)}`) {
      checked.set(`${r.gold_id}|${r.fib_id}|${Number(r.high)}|${Number(r.low)}|${Number(r.tolerance)}`, Number(r.checked_to));
    }
  }
  const checkedTo = (g: postgres.Row, f: Fib) => checked.get(`${g.id}|${f.id}|${Number(f.high)}|${Number(f.low)}|${settings.fibTolerancePct}`);
  const nextChecks: Array<Record<string, unknown>> = [];
  const pending = golds.flatMap((g) => fibs
    .filter((f) => f.symbol === g.symbol && f.direction === g.direction && !done.has(`${g.id}|${f.id}`))
    .map((f) => ({ g, f })));
  const bySymbol = new Map<string, typeof pending>();
  for (const p of pending) bySymbol.set(p.g.symbol, [...(bySymbol.get(p.g.symbol) ?? []), p]);

  await pool([...bySymbol.entries()], 3, async ([symbol, pairs]) => {
    let candles: Candle[];
    try {
      const from = Math.min(...pairs.map((p) => checkedTo(p.g, p.f) ?? new Date(p.g.signal_time).getTime()));
      candles = await candlesSince(symbol, "15m", from);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    // Candles from the one still forming on are read again next time, as it can still reach a level
    const formingT = candles.length ? candles[candles.length - 1].t : null;
    for (const { g, f } of pairs) {
      const goldAt = new Date(g.signal_time).getTime();
      const touch = firstTouch(candles, fibLevels(f), Math.max(goldAt, checkedTo(g, f) ?? 0), settings.fibTolerancePct);
      if (!touch && formingT != null) {
        nextChecks.push({ gold_id: g.id, fib_id: f.id, high: Number(f.high), low: Number(f.low), tolerance: settings.fibTolerancePct, checked_to: Math.max(formingT, checkedTo(g, f) ?? 0) });
      }
      if (!touch || touch.t > new Date(g.window_end).getTime()) {
        if (touch) nextChecks.push({ gold_id: g.id, fib_id: f.id, high: Number(f.high), low: Number(f.low), tolerance: settings.fibTolerancePct, checked_to: touch.t });
        continue;
      }
      const atSignal = touch.t < goldAt + (TF_MS[g.tf] ?? 0);
      await sql`
        INSERT INTO fib_hits (gold_id, fib_id, ratio, level, touched_at, at_signal)
        VALUES (${g.id}, ${f.id}, ${touch.ratio}, ${touch.level}, ${new Date(touch.t)}, ${atSignal})
        ON CONFLICT DO NOTHING`;
      fibHits++;
      const gold = SIGNAL_BY_CODE[g.code];
      await alert(settings.fibTouch, `fib:${g.id}:${f.id}`,
        async () =>
        `🎯 <b>${esc(symbol)}</b> ${tfLabel(g.tf)} <b>${gold.name}</b> (${when(g.signal_time)})\n` +
        `Price ${atSignal ? "was at" : "touched"} the ${fibName(f)} <b>${touch.ratio}</b> = ${fmtPrice(touch.level)} at ${when(touch.t)}` +
        `${f.note ? ` (${esc(f.note)})` : ""}\nTrend: ${await trendLine(symbol)}`,
        recent(touch.t, g.first_seen_at));
    }
  });

  // Remember how far each pair was read; forget pairs whose Gold signal is out of its window
  await sql`DELETE FROM fib_touch_checks WHERE ${goldIds.length ? sql`gold_id NOT IN ${sql(goldIds)}` : sql`true`}`;
  for (let i = 0; i < nextChecks.length; i += 1000) {
    await sql`
      INSERT INTO fib_touch_checks ${sql(nextChecks.slice(i, i + 1000) as never, "gold_id", "fib_id", "high", "low", "tolerance", "checked_to")}
      ON CONFLICT (gold_id, fib_id) DO UPDATE SET high = EXCLUDED.high, low = EXCLUDED.low, tolerance = EXCLUDED.tolerance,
        checked_to = EXCLUDED.checked_to`;
  }

  // ── BOS/CHoCH after a fib touch: the stronger signal ──
  const open = await sql`
    SELECT h.*, g.symbol, g.tf AS gold_tf, g.code AS gold_code, g.direction, g.signal_time AS gold_time,
      g.signal_time + ${windowCase} AS window_end, f.tf AS fib_tf, f.direction AS fib_dir, f.source AS fib_source
    FROM fib_hits h JOIN signals g ON g.id = h.gold_id JOIN fibs f ON f.id = h.fib_id
    WHERE h.structure_id IS NULL AND g.signal_time + ${windowCase} > now() - interval '1 hour'`;
  // Every BOS/CHoCH that could follow one of them, in one query, then matched to each below
  const structure = open.length ? await sql`
    SELECT * FROM signals WHERE source = 'structure' AND symbol IN ${sql([...new Set(open.map((h) => h.symbol as string))])}
      AND signal_time > ${new Date(Math.min(...open.map((h) => new Date(h.gold_time).getTime())))}
    ORDER BY signal_time` : [];
  for (const h of open) {
    const goldT = new Date(h.gold_time).getTime(), endT = new Date(h.window_end).getTime();
    const candidates = structure.filter((c) => c.symbol === h.symbol && c.direction === h.direction &&
      new Date(c.signal_time).getTime() > goldT && new Date(c.signal_time).getTime() <= endT);
    // A structure signal is stamped with its bar's open time and confirms when that bar closes.
    const s = candidates.find((c) => new Date(c.signal_time).getTime() + (TF_MS[c.tf] ?? 0) > new Date(h.touched_at).getTime());
    if (!s) continue;
    await sql`UPDATE fib_hits SET structure_id = ${s.id} WHERE gold_id = ${h.gold_id} AND fib_id = ${h.fib_id}`;
    structureAfterFib++;
    await alert(settings.fibStructure, `fibs:${h.gold_id}:${h.fib_id}`,
      async () =>
      `💥 <b>Stronger: ${esc(h.symbol)}</b> ${tfLabel(h.gold_tf)} <b>${SIGNAL_BY_CODE[h.gold_code].name}</b> (${when(h.gold_time)})\n` +
      `→ ${tfLabel(h.fib_tf)} ${h.fib_dir === "bull" ? "🟢" : "🔴"} ${h.fib_source === "auto" ? "auto " : ""}fib ${h.ratio} touched ${when(h.touched_at)}\n` +
      `→ ${tfLabel(s.tf)} <b>${SIGNAL_BY_CODE[s.code].name}</b> ${when(s.signal_time)}\nTrend: ${await trendLine(h.symbol)}`,
      recent(s.first_seen_at));
  }

  // ── New Gold signals, and Gold followed by BOS/CHoCH ──
  if (telegramReady()) {
    if (settings.gold) {
      for (const g of await sql`SELECT * FROM signals WHERE family = 'gold' AND first_seen_at > now() - interval '3 hours'`) {
        await alert(true, `gold:${g.id}`,
          async () =>
          `${g.direction === "bull" ? "🔥" : "❄️"} <b>${esc(g.symbol)}</b> ${tfLabel(g.tf)} <b>${SIGNAL_BY_CODE[g.code].name}</b> ${when(g.signal_time)}\nTrend: ${await trendLine(g.symbol)}`,
          recent(g.first_seen_at));
      }
    }
    if (settings.goldStructure) {
      const pairs = await sql`
        SELECT g.id AS gold_id, g.symbol, g.tf AS gold_tf, g.code AS gold_code, g.signal_time AS gold_time,
          s.id AS s_id, s.tf AS s_tf, s.code AS s_code, s.signal_time AS s_time, s.first_seen_at AS s_seen
        FROM signals s JOIN signals g ON g.symbol = s.symbol AND g.family = 'gold' AND g.direction = s.direction
          AND g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}
          AND s.signal_time > g.signal_time AND s.signal_time <= g.signal_time + ${windowCase}
        WHERE s.source = 'structure' AND s.first_seen_at > now() - interval '3 hours'`;
      for (const p of pairs) {
        await alert(true, `gs:${p.gold_id}:${p.s_id}`,
          async () =>
          `✅ <b>${esc(p.symbol)}</b> ${tfLabel(p.gold_tf)} <b>${SIGNAL_BY_CODE[p.gold_code].name}</b> (${when(p.gold_time)}) → ` +
          `${tfLabel(p.s_tf)} <b>${SIGNAL_BY_CODE[p.s_code].name}</b> ${when(p.s_time)}\nTrend: ${await trendLine(p.symbol)}`,
          recent(p.s_seen));
      }
    }
  }

  // ── The Telegram digest: new Gold signals and fib hits ──
  try {
    alertsSent += await sendDigest(sql, settings, errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    alertsSent += await checkStale(sql);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const summary: TickSummary = {
    symbols: symbols.length, trendsUpdated, fibsRedrawn, levelHits, priceAlerts, oscChecked, manualFibsRemoved, fibHits, structureAfterFib, alertsSent,
    errors: [...new Set(errors)].slice(0, 20), ms: Date.now() - started,
  };
  await sql`INSERT INTO ticks (summary) VALUES (${sql.json({ ...summary })})`;
  await sql`DELETE FROM ticks WHERE id < (SELECT max(id) - 200 FROM ticks)`;
  return summary;
}
