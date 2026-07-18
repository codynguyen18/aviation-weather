import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { freshnessOf } from "@/lib/wx/freshness";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Weather-source inspector (PLAN.md §15.4): the verbatim upstream payload and
// its normalized companion rows, side by side, with freshness state — every
// datum in the app can be traced back to exactly this.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid record id" }, { status: 400 });
  }
  // Weather products are public data, but the inspector is still gated to
  // signed-in users like the rest of the app surface.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  try {
    const [rec] = await sql`
      SELECT id, source_type, station, external_key, issued_at, valid_from,
             valid_to, fetched_at, upstream_url, raw, parse_status
      FROM source_records WHERE id = ${id}
    `;
    if (!rec) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const sourceType = rec.source_type as string;
    let normalized: unknown = null;
    if (sourceType === "METAR") {
      normalized = (await sql`
        SELECT * FROM weather_observations WHERE source_record_id = ${id}
      `)[0] ?? null;
    } else if (sourceType === "TAF") {
      normalized = await sql`
        SELECT * FROM weather_forecasts WHERE source_record_id = ${id}
        ORDER BY group_seq
      `;
    } else if (sourceType === "PIREP") {
      normalized = (await sql`
        SELECT * FROM pireps WHERE source_record_id = ${id}
      `)[0] ?? null;
    }
    return NextResponse.json({
      record: rec,
      normalized,
      freshness: freshnessOf(sourceType, rec.issued_at as string | null),
    });
  } catch (err) {
    logger.error({ err, id }, "inspector query failed");
    return NextResponse.json({ error: "inspector unavailable" }, { status: 503 });
  }
}
