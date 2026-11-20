import { NextResponse } from "next/server";
import { cached, dataChanged } from "@/lib/cache";
import { db } from "@/lib/db";
import { tick } from "@/lib/radar";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
// Bitget's API refuses some US addresses, so this runs from Singapore rather than Vercel's default US region.
export const preferredRegion = "sin1";

/** Runs the check: trends, fib touches, BOS/CHoCH after them, Telegram alerts. Called every 15 minutes and after uploads. */
export async function POST(req: Request) {
  try {
    const light = new URL(req.url).searchParams.get("light") === "1";
    const summary = await tick(await db(), { light });
    dataChanged();
    return NextResponse.json(summary);
  } catch (e) {
    return fail(e);
  }
}

/** The last few runs. */
export async function GET() {
  try {
    return NextResponse.json(await cached(["ticks"], async () => {
      const sql = await db();
      return [...await sql`SELECT started_at, summary FROM ticks ORDER BY id DESC LIMIT 10`];
    }));
  } catch (e) {
    return fail(e);
  }
}
