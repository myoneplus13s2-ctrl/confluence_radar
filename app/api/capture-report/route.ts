import { NextResponse } from "next/server";
import { dataChanged } from "@/lib/cache";
import { db } from "@/lib/db";
import { CaptureReport, captureReport } from "@/lib/health";
import { fail } from "@/lib/http";

export const runtime = "nodejs";

/** capture.mjs reports each run here, so a failed or short chart can be sent to Telegram. */
export async function POST(req: Request) {
  try {
    const parsed = CaptureReport.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad report.", 400);
    const problems = await captureReport(await db(), parsed.data);
    dataChanged();
    return NextResponse.json({ problems });
  } catch (e) {
    return fail(e);
  }
}
