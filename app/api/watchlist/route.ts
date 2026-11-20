import { NextResponse } from "next/server";
import { cached, dataChanged } from "@/lib/cache";
import { db } from "@/lib/db";
import { tickAfterUpload } from "@/lib/after-upload";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "@/lib/watchlist";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
// Bitget's API refuses some US addresses (see /api/tick)
export const preferredRegion = "sin1";

/** The watchlist, oldest first. */
export async function GET() {
  try {
    return NextResponse.json(await cached(["watchlist"], async () => listWatchlist(await db())));
  } catch (e) {
    return fail(e);
  }
}

/** Body: {symbol}. Adds it, then runs the check so its oscillator, trends and fibs fill in shortly. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { symbol?: unknown };
    if (typeof body.symbol !== "string") return fail("Type a symbol, e.g. BTCUSDT.P.", 400);
    const sql = await db();
    const symbol = await addToWatchlist(sql, body.symbol);
    dataChanged();
    tickAfterUpload(req, { light: false });
    return NextResponse.json({ symbol, list: await listWatchlist(sql) });
  } catch (e) {
    return fail(e, 400);
  }
}

/** ?symbol=BTCUSDT.P removes it. */
export async function DELETE(req: Request) {
  try {
    const symbol = new URL(req.url).searchParams.get("symbol");
    if (!symbol) return fail("Which symbol?", 400);
    const sql = await db();
    await removeFromWatchlist(sql, symbol);
    dataChanged();
    return NextResponse.json(await listWatchlist(sql));
  } catch (e) {
    return fail(e);
  }
}
