import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import {
  deleteMinimumsProfile,
  listMinimumsProfiles,
  minimumsProfileSchema,
  saveMinimumsProfile,
} from "@/lib/account/store";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function requireUser() {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  try {
    return NextResponse.json({ profiles: await listMinimumsProfiles(sql, userId) });
  } catch (err) {
    logger.error({ err }, "minimums profiles list failed");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const parsed = minimumsProfileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid profile", detail: parsed.error.issues }, { status: 400 });
  }
  const id = await saveMinimumsProfile(sql, userId, parsed.data);
  return NextResponse.json({ id });
}

export async function DELETE(req: NextRequest) {
  const userId = await requireUser();
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const ok = await deleteMinimumsProfile(sql, userId, id);
  return ok
    ? NextResponse.json({ deleted: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
