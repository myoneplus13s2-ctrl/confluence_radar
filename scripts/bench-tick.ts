// Measures one check (tick) against a local Postgres and a fake Bitget: CPU time, database queries, Bitget calls.
// Run: DATABASE_URL=postgres://... npx tsx scripts/bench-tick.ts [symbols=60]
// The tables are dropped first, so point it at a throwaway database.
import http from "node:http";
import postgres from "postgres";

const SYMBOLS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 60);
const G: Record<string, number> = { "1m": 60e3, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1H": 36e5, "2H": 72e5, "4H": 144e5, "1Dutc": 864e5, "1Wutc": 6048e5 };
let calls = 0, bytes = 0;
function rows(sym: string, g: string, end: number, n: number): string[][] {
  const ms = G[g];
  const last = Math.floor(end / ms) * ms;
  const out: string[][] = [];
  let seed = 0;
  for (const ch of sym + g) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  for (let t = last - (n - 1) * ms; t <= last; t += ms) {
    const k = t / ms;
    const p = 100 + 20 * Math.sin(k / 37 + seed) + 8 * Math.sin(k / 9 + seed / 7) + 3 * Math.sin(k / 2.3);
    const o = p, c = p + Math.sin(k * 1.7 + seed) * 1.5;
    out.push([String(t), o.toFixed(4), (Math.max(o, c) + 0.8).toFixed(4), (Math.min(o, c) - 0.8).toFixed(4), c.toFixed(4), "1000", "1000"]);
  }
  return out.reverse();
}
const server = http.createServer((req, res) => {
  calls++;
  const u = new URL(req.url!, "http://x");
  const q = Object.fromEntries(u.searchParams);
  let data: unknown;
  if (u.pathname.endsWith("/tickers")) data = Array.from({ length: SYMBOLS }, (_, i) => ({ symbol: `S${i}USDT`, lastPr: "100" }));
  else if (u.pathname.endsWith("/history-candles")) data = rows(q.symbol, q.granularity, Number(q.endTime) - G[q.granularity], 200);
  else {
    const n = Math.min(Number(q.limit || 100), 1000);
    data = rows(q.symbol, q.granularity, q.endTime ? Number(q.endTime) : Date.now(), n);
  }
  const body = JSON.stringify({ code: "00000", data });
  bytes += body.length;
  res.setHeader("content-type", "application/json");
  res.end(body);
});

async function main() {
  // The fake Bitget runs in its own process so its work isn't counted
  const { fork } = await import("node:child_process");
  const child = fork(process.argv[1], ["--server", String(SYMBOLS)], { execArgv: process.execArgv });
  await new Promise((r) => child.once("message", r));
  const stats = () => new Promise<{ calls: number; bytes: number }>((r) => { child.once("message", r as never); child.send("stats"); });
  process.env.BITGET_API_URL = "http://127.0.0.1:4100";
  let queries = 0;
  const qlog = new Map<string, number>();
  globalThis.__sql = postgres(process.env.DATABASE_URL!, { max: 3, prepare: false, onnotice: () => {}, debug: (_c: unknown, q: string) => { queries++; if (process.env.QLOG) { const k = q.replace(/\s+/g, " ").trim().slice(0, 70); qlog.set(k, (qlog.get(k) ?? 0) + 1); } } });
  const { db } = await import("../lib/db");
  const { tick } = await import("../lib/radar");
  const sql = globalThis.__sql;
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const s = await db();
  const now = Date.now();
  for (let i = 0; i < SYMBOLS; i++) {
    const tfs = ["15m", "1h", "4h", "1D"];
    for (const [j, tf] of tfs.entries()) {
      const dir = (i + j) % 2 ? "bull" : "bear";
      await s`INSERT INTO signals (symbol, source, tf, code, family, direction, signal_time, first_seen_at, last_seen_at)
        VALUES (${`S${i}USDT.P`}, 'divergence', ${tf}, ${dir === "bull" ? "GOLD_BUY" : "GOLD_SELL"}, 'gold', ${dir},
          ${new Date(now - [20, 80, 200, 400][j] * 3600e3)}, ${new Date(now - 5 * 3600e3)}, ${new Date(now)})`;
    }
  }
  const run = async (label: string) => {
    queries = 0;
    await stats();
    const cpu = process.cpuUsage();
    const t0 = Date.now();
    const r = await tick(s);
    const c = process.cpuUsage(cpu);
    const { calls, bytes } = await stats();
    console.log(`${label.padEnd(26)} cpu ${((c.user + c.system) / 1000).toFixed(0).padStart(6)} ms  wall ${String(Date.now() - t0).padStart(6)} ms  queries ${String(queries).padStart(5)}  bitget ${String(calls).padStart(4)} calls ${(bytes / 1e6).toFixed(1).padStart(5)} MB  errors ${r.errors.length}`);
    if (process.env.QLOG) { for (const [k, n] of [...qlog].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(n).padStart(6), k); qlog.clear(); }
  };
  await run("1 first run (catch-up)");
  await run("2 next run (catch-up)");
  await run("3 next run (steady)");
  await run("4 next run (steady)");
  await s`DELETE FROM fib_runs`;
  await s`DELETE FROM osc_readings`;
  await run("5 all timeframes due");
  await sql.end();
  child.kill();
}
if (process.argv.includes("--server")) {
  server.listen(4100, () => process.send?.("ready"));
  process.on("message", () => { process.send!({ calls, bytes }); calls = 0; bytes = 0; });
} else main().catch((e) => { console.error(e); process.exit(1); });
