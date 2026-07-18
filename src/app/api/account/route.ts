import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { sql } from "@/db";
import { deleteAccount } from "@/lib/account/store";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// DELETE /api/account — hard delete of the signed-in user and everything they
// own (profiles, plans, briefings, conversations). Shared weather records
// remain, per the privacy plan (PLAN.md §17).
export async function DELETE() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  try {
    await deleteAccount(sql, userId);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    logger.error({ err, userId }, "account deletion failed");
    return NextResponse.json({ error: "deletion failed" }, { status: 503 });
  }
}
