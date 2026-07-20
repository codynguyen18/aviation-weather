import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { userOwnsSnapshot } from "@/lib/account/store";
import { checkRateLimit } from "@/lib/account/rate-limit";
import { AnthropicAdapter } from "@/lib/llm/adapter";
import { runChat } from "@/lib/llm/chat";

export const dynamic = "force-dynamic";
// 60s is the ceiling on Vercel's Hobby plan; persistent hosts ignore this.
export const maxDuration = 60;

const bodySchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().min(1).max(2000),
});

// POST /api/briefings/:id/chat — ask the grounded assistant one question.
// Replies stream as SSE: `status` events while working, then one `final`
// event carrying the validated message (or the deterministic fallback).
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid snapshot id" }, { status: 400 });
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  if (!(await userOwnsSnapshot(sql, userId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "message required (max 2000 chars)" }, { status: 400 });
  }
  const limit = await checkRateLimit(sql, `chat:${userId}`, 60, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `chat limit reached (60 messages/hour) — try again in ~${limit.retryAfterMin} min` },
      { status: 429 },
    );
  }
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "AI chat is not configured yet: set ANTHROPIC_API_KEY in the server environment to enable it.",
      },
      { status: 503 },
    );
  }
  const adapter = new AnthropicAdapter(apiKey, env().ANTHROPIC_MODEL);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      try {
        const outcome = await runChat({
          sql,
          snapshotId: id,
          conversationId: parsed.data.conversationId ?? null,
          userMessage: parsed.data.message,
          adapter,
          onStatus: (status) => send("status", { status }),
        });
        send("final", outcome);
      } catch (err) {
        const code = (err as { code?: string }).code;
        logger.error({ err, id }, "chat failed");
        send("error", {
          error: code === "NOT_FOUND" ? "briefing not found" : "chat failed — try again",
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// GET /api/briefings/:id/chat[?conversationId=...] — stored transcript so the
// panel survives reloads.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid snapshot id" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  if (!(await userOwnsSnapshot(sql, session.user.id, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const qs = req.nextUrl.searchParams.get("conversationId");
  const conversationId = qs && z.string().uuid().safeParse(qs).success ? qs : null;
  try {
    const [conv] = conversationId
      ? await sql`SELECT id FROM conversations
                  WHERE id = ${conversationId} AND snapshot_id = ${id}`
      : await sql`SELECT id FROM conversations WHERE snapshot_id = ${id}
                  ORDER BY created_at DESC LIMIT 1`;
    if (!conv) return NextResponse.json({ conversationId: null, messages: [] });
    const messages = await sql`
      SELECT role, content, citations, validation, is_fallback, created_at
      FROM conversation_messages
      WHERE conversation_id = ${conv.id}
      ORDER BY seq
    `;
    return NextResponse.json({ conversationId: conv.id, messages });
  } catch (err) {
    logger.error({ err, id }, "chat history fetch failed");
    return NextResponse.json({ error: "history unavailable" }, { status: 503 });
  }
}
