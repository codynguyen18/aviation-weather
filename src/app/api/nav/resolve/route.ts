import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sql } from "@/db";
import { resolveIdent } from "@/lib/nav/resolver";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({ q: z.string().min(1).max(40) });

// GET /api/nav/resolve?q=KSTL -> resolved | ambiguous (with candidates) | not-found
export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse({
    q: req.nextUrl.searchParams.get("q") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "missing or invalid q parameter" },
      { status: 400 },
    );
  }
  try {
    const result = await resolveIdent(sql, parsed.data.q);
    return NextResponse.json(result, {
      status: result.status === "not-found" ? 404 : 200,
    });
  } catch (err) {
    logger.error({ err, q: parsed.data.q }, "resolve failed");
    return NextResponse.json({ error: "resolver unavailable" }, { status: 503 });
  }
}
