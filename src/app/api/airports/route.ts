import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sql } from "@/db";
import { parseLatLon, airportsNear, resolveIdent } from "@/lib/nav/resolver";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const nearSchema = z.object({
  near: z.string(),
  r: z.coerce.number().min(1).max(200).default(30),
});

// GET /api/airports?near=38.03,-120.41&r=30  -> airports within r nm
// GET /api/airports?ident=KSTL               -> single airport lookup
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  try {
    const ident = params.get("ident");
    if (ident) {
      const result = await resolveIdent(sql, ident);
      return NextResponse.json(result, {
        status: result.status === "not-found" ? 404 : 200,
      });
    }

    const parsed = nearSchema.safeParse({
      near: params.get("near") ?? "",
      r: params.get("r") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "provide ?ident=XXXX or ?near=lat,lon (r 1-200 nm)" },
        { status: 400 },
      );
    }
    const point = parseLatLon(parsed.data.near);
    if (!point) {
      return NextResponse.json(
        { error: "near must be lat,lon decimal degrees" },
        { status: 400 },
      );
    }
    const airports = await airportsNear(
      sql,
      point.lat,
      point.lon,
      parsed.data.r,
    );
    return NextResponse.json({ airports, radiusNm: parsed.data.r });
  } catch (err) {
    logger.error({ err }, "airports query failed");
    return NextResponse.json({ error: "airports unavailable" }, { status: 503 });
  }
}
