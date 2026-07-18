import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sql } from "@/db";
import { searchWaypoints } from "@/lib/nav/resolver";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().min(2).max(40),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// GET /api/nav/search?q=oakl -> typeahead candidates for the route entry UI
export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse({
    q: req.nextUrl.searchParams.get("q") ?? "",
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "q must be 2-40 characters; limit 1-25" },
      { status: 400 },
    );
  }
  try {
    const results = await searchWaypoints(sql, parsed.data.q, parsed.data.limit);
    return NextResponse.json({ results });
  } catch (err) {
    logger.error({ err, q: parsed.data.q }, "search failed");
    return NextResponse.json({ error: "search unavailable" }, { status: 503 });
  }
}
