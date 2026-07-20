import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { hazardsForSegment, hazardsNearRoute } from "@/lib/wx/intersect";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import type { RouteModel } from "@/lib/route/types";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Hazards for the dashboard map. Returns every hazard *near* the route (full
// shape, clickable) with an `onRoute` flag marking the ones that actually pass
// the three-gate corridor/altitude/time test and drove the segment ratings.
// So the map shows the surrounding weather too — not only what changed a color.
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

    // Which hazards actually clip the corridor (drove the ratings)?
    const onRoute = new Set<string>();
    await mapWithConcurrency(route.segments, 6, async (seg) => {
      const hits = await hazardsForSegment(sql, seg, {
        corridorWidthNm: request.corridorWidthNm ?? 25,
        altitudeBandFt: request.altitudeBandFt ?? 4000,
        timeBufferMin: 30,
      });
      for (const h of hits) onRoute.add(h.hazardId);
    });

    const near = await hazardsNearRoute(sql, route);
    const hazards = near.map((h) => ({ ...h, onRoute: onRoute.has(h.hazardId) }));

    return NextResponse.json({
      hazards,
      onRouteCount: hazards.filter((h) => h.onRoute).length,
      nearbyCount: hazards.filter((h) => !h.onRoute).length,
    });
  } catch (err) {
    logger.error({ err, id }, "hazard overlay failed");
    return NextResponse.json({ error: "hazards unavailable" }, { status: 503 });
  }
}
