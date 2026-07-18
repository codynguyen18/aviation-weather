import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sql } from "@/db";
import { logger } from "@/lib/logger";
import { resolveIdent } from "@/lib/nav/resolver";
import { corridorsFor } from "@/lib/route/corridor";
import { buildRoute } from "@/lib/route/engine";
import {
  performanceSchema,
  routeOptionsSchema,
  type RouteWaypoint,
} from "@/lib/route/types";

export const dynamic = "force-dynamic";

// POST /api/route/preview — stateless route + timeline computation
// (PLAN.md §14 preview-times; persistence of plans arrives in M9).
// Weather plays no part yet: zero-wind ETAs, no hazards (M4/M5).
const bodySchema = z.object({
  waypoints: z
    .array(
      z.object({
        ident: z.string().min(1).max(40),
        isFuelStop: z.boolean().default(false),
        groundMinutes: z.number().min(0).max(1440).default(45),
      }),
    )
    .min(2)
    .max(30),
  departureTimeUtc: z.string().datetime({ offset: true }),
  cruiseAltitudeFt: z.number().min(500).max(30000),
  performance: performanceSchema,
  segmentMaxNm: z.number().min(10).max(200).default(50),
  corridorWidthNm: z.number().min(5).max(60).default(25),
  includeCorridor: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid request", detail: err instanceof z.ZodError ? err.issues : String(err) },
      { status: 400 },
    );
  }

  try {
    // Resolve every waypoint; collect problems instead of failing fast so the
    // UI can show all of them at once.
    const resolved: RouteWaypoint[] = [];
    const problems: { ident: string; status: string; candidates?: unknown }[] = [];
    for (const w of body.waypoints) {
      const r = await resolveIdent(sql, w.ident);
      if (r.status === "resolved") {
        resolved.push({
          ...r.waypoint,
          isFuelStop: w.isFuelStop,
          groundMinutes: w.groundMinutes,
        });
      } else {
        problems.push({
          ident: w.ident,
          status: r.status,
          ...(r.status === "ambiguous" ? { candidates: r.candidates } : {}),
        });
      }
    }
    if (problems.length > 0) {
      return NextResponse.json(
        { error: "unresolved waypoints", problems },
        { status: 422 },
      );
    }

    const opts = routeOptionsSchema.parse(body);
    const model = buildRoute(resolved, opts);

    const corridors = body.includeCorridor
      ? await corridorsFor(sql, model.segments, body.corridorWidthNm)
      : [];

    return NextResponse.json({ route: model, corridors });
  } catch (err) {
    logger.error({ err }, "route preview failed");
    return NextResponse.json(
      { error: "route preview unavailable" },
      { status: 503 },
    );
  }
}
