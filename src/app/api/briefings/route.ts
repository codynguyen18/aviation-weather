import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sql } from "@/db";
import { coordinator } from "@/lib/ingest/coordinator";
import {
  briefingRequestSchema,
  generateBriefing,
} from "@/lib/briefing/generate";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/briefings — generate a briefing snapshot for a route request.
export async function POST(req: NextRequest) {
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
    const result = await generateBriefing(sql, coordinator(), request);
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
