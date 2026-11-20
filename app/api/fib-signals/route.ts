import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { db } from "@/lib/db";
import { fibSignals } from "@/lib/queries";
import { fail, num } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const days = num(q.get("sinceDays")) ?? 14;
    return NextResponse.json(await cached(["fib-signals", days], async () => fibSignals(await db(), days)));
  } catch (e) {
    return fail(e);
  }
}
