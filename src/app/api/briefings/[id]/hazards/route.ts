import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { hazardsForSegment } from "@/lib/wx/intersect";
import type { RouteModel } from "@/lib/route/types";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Hazard overlays for the dashboard map: re-runs the three-gate intersection
// for each segment of a stored snapshot (hazard rows are retained while any
// snapshot links their source records).
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  try {
    const [snap] = await sql`
      SELECT route, request FROM briefing_snapshots
      WHERE id = ${id} AND user_id = ${session.user.id}
    `;
    if (!snap) return NextResponse.json({ error: "not found" }, { status: 404 });
    const route = snap.route as RouteModel;
    const request = snap.request as { corridorWidthNm?: number; altitudeBandFt?: number };
    const out = [];
    for (const seg of route.segments) {
      const hits = await hazardsForSegment(sql, seg, {
        corridorWidthNm: request.corridorWidthNm ?? 25,
        altitudeBandFt: request.altitudeBandFt ?? 4000,
        timeBufferMin: 30,
      });
      for (const h of hits) {
        out.push({
          segmentSeq: seg.seq,
          product: h.product,
          hazard: h.hazard,
          validFrom: h.validFrom,
          validTo: h.validTo,
          clipNm: h.clipNm,
          geometry: h.clipGeojson,
          sourceRecordId: h.sourceRecordId,
        });
      }
    }
    return NextResponse.json({ hazards: out });
  } catch (err) {
    logger.error({ err, id }, "hazard overlay failed");
    return NextResponse.json({ error: "hazards unavailable" }, { status: 503 });
  }
}
