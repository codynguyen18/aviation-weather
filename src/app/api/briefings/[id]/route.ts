import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// GET /api/briefings/:id — a stored snapshot, exactly as generated.
// Scoped to the owning user at the query layer.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid snapshot id" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  try {
    const [snap] = await sql`
      SELECT id, created_at, ruleset_version, engine_version, status,
             partial_reasons, request, route, refresh_summary, trip_summary
      FROM briefing_snapshots WHERE id = ${id} AND user_id = ${session.user.id}
    `;
    if (!snap) return NextResponse.json({ error: "not found" }, { status: 404 });
    const assessments = await sql`
      SELECT segment_seq, rating, confidence, summary, hard_stops
      FROM segment_assessments WHERE snapshot_id = ${id} ORDER BY segment_seq
    `;
    const evaluations = await sql`
      SELECT segment_seq, rule_id, rule_version, rule_class, result, measured,
             thresholds, confidence, explanation, is_hard_stop, source_record_ids
      FROM rule_evaluations WHERE snapshot_id = ${id}
      ORDER BY segment_seq, rule_id
    `;
    return NextResponse.json({ snapshot: snap, assessments, evaluations });
  } catch (err) {
    logger.error({ err, id }, "briefing fetch failed");
    return NextResponse.json({ error: "briefing unavailable" }, { status: 503 });
  }
}
