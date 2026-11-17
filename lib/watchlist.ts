// The user's watchlist: symbols shown on the Watchlist tab and always covered by the periodic check.
import type postgres from "postgres";
import { bitgetSymbol, lastPrices } from "./market";
import { normalizeSymbol } from "./signals";

/** "jup", "JUPUSDT", "BITGET:JUPUSDT.P" -> "JUPUSDT.P", the form the rest of the site stores. */
export function watchSymbol(raw: string): string {
  let s = normalizeSymbol(raw).replace(/\.P$/, "").replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (!/USDT$/.test(s)) s += "USDT";
  return `${s}.P`;
}

export async function listWatchlist(sql: postgres.Sql): Promise<Array<{ symbol: string; added_at: Date }>> {
  const rows = await sql`SELECT symbol, added_at FROM watchlist ORDER BY added_at`;
  return rows as unknown as Array<{ symbol: string; added_at: Date }>;
}

/** Adds a symbol after checking Bitget lists it (skipped when Bitget can't be reached right now). Returns its stored form. */
export async function addToWatchlist(sql: postgres.Sql, raw: string): Promise<string> {
  const symbol = watchSymbol(raw);
  if (!symbol) throw new Error("Type a symbol, e.g. BTCUSDT.P or BTC.");
  let live: Map<string, number> | null = null;
  try {
    live = await lastPrices();
  } catch { /* Bitget out of reach for a moment: add it anyway */ }
  if (live && live.size && !live.has(bitgetSymbol(symbol))) {
    throw new Error(`Bitget has no ${bitgetSymbol(symbol)} perpetual. Check the symbol, e.g. BTCUSDT.P.`);
  }
  await sql`INSERT INTO watchlist (symbol) VALUES (${symbol}) ON CONFLICT DO NOTHING`;
  return symbol;
}

export async function removeFromWatchlist(sql: postgres.Sql, raw: string): Promise<void> {
  await sql`DELETE FROM watchlist WHERE symbol = ${watchSymbol(raw)}`;
}
