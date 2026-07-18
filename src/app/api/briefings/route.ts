import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { coordinator } from "@/lib/ingest/coordinator";
import {
  briefingRequestSchema,
  generateBriefing,
} from "@/lib/briefing/generate";
import { audit } from "@/lib/account/store";
import { checkRateLimit } from "@/lib/account/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/briefings — generate a briefing snapshot for a route request.
// Signed-in users only; each briefing triggers a burst of upstream fetches,
// so generation is rate-limited per user.
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "sign in to generate briefings" }, { status: 401 });
  }
  const limit = await checkRateLimit(sql, `briefing:${userId}`, 10, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `briefing limit reached (10/hour) — try again in ~${limit.retryAfterMin} min` },
      { status: 429 },
    );
  }
  let request;
  try {
    request = briefingRequestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid request", detail: err instanceof z.ZodError ? err.issues : String(err) },
      { status: 400 },
    );
  }
  try {
    const result = await generateBriefing(sql, coordinator(), request, { userId });
    await audit(sql, userId, "briefing.create", { snapshotId: result.snapshotId });
    return NextResponse.json(result);
  } catch (err) {
    if ((err as { code?: string }).code === "UNRESOLVED") {
      return NextResponse.json(
        { error: String((err as Error).message), detail: (err as { detail?: unknown }).detail },
        { status: 422 },
      );
    }
    logger.error({ err }, "briefing generation failed");
    return NextResponse.json({ error: "briefing generation failed" }, { status: 503 });
  }
}
