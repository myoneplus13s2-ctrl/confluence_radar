import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { db } from "@/lib/db";
import { listTrends } from "@/lib/queries";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await cached(["trends"], async () => listTrends(await db())));
  } catch (e) {
    return fail(e);
  }
}
