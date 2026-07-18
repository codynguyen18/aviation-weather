import { NextResponse } from "next/server";

import { sql } from "@/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Reports whether the app can reach its database and whether PostGIS (the
// geometry engine every briefing depends on) is actually installed there.
export async function GET() {
  try {
    const rows = await sql`SELECT postgis_version() AS postgis`;
    return NextResponse.json({
      status: "ok",
      db: "connected",
      postgis: rows[0]?.postgis ?? "missing",
    });
  } catch (err) {
    logger.error({ err }, "health check failed");
    return NextResponse.json(
      { status: "degraded", db: "unreachable", postgis: "unknown" },
      { status: 503 },
    );
  }
}
