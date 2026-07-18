import type { Sql } from "postgres";
import { z } from "zod";

import type { LlmToolDef } from "@/lib/llm/adapter";
import { rawTextOf, UNTRUSTED_CLOSE, UNTRUSTED_OPEN, type BriefingContext } from "@/lib/llm/context";
import { diffBriefings } from "@/lib/briefing/diff";

// Read-only tools for the chat model (PLAN.md §12.3). Every tool answers
// from data already stored for THIS snapshot — nothing here fetches from the
// network or writes anything. Tool outputs are appended to the grounding
// text, so the validator accepts figures the model learned through them.

export function buildChatTools(sql: Sql, ctx: BriefingContext): LlmToolDef[] {
  const bySrcTag = new Map(ctx.sourceIndex.map((s) => [s.tag, s]));

  return [
    {
      name: "get_source_full_text",
      description:
        "Full verbatim text of one source from the SOURCES list (the context may truncate long products). Input: the src tag number.",
      inputSchema: {
        type: "object",
        properties: { tag: { type: "number", description: "the N in [src:N]" } },
        required: ["tag"],
      },
      async run(input) {
        const { tag } = z.object({ tag: z.number().int() }).parse(input);
        const entry = bySrcTag.get(tag);
        if (!entry) return `error: [src:${tag}] is not in this briefing's source list`;
        const [row] = await sql`
          SELECT s.source_type, s.raw, h.raw_text AS hazard_raw_text
          FROM source_records s
          LEFT JOIN LATERAL (
            SELECT raw_text FROM hazard_geometries WHERE source_record_id = s.id LIMIT 1
          ) h ON true
          WHERE s.id = ${entry.sourceRecordId}
        `;
        if (!row) return `error: source record no longer available`;
        const text = rawTextOf(
          row.source_type as string,
          row.raw,
          (row.hazard_raw_text as string | null) ?? null,
        );
        const fenced =
          entry.sourceType === "AFD" ? `${UNTRUSTED_OPEN}\n${text}\n${UNTRUSTED_CLOSE}` : text;
        return `[src:${tag}] ${entry.label} (full text):\n${fenced}`;
      },
    },
    {
      name: "get_segment_rules",
      description:
        "Every rule evaluation for one segment of this briefing, including rules that did not fire — with measured values, thresholds, and src tags.",
      inputSchema: {
        type: "object",
        properties: { segment_seq: { type: "number" } },
        required: ["segment_seq"],
      },
      async run(input) {
        const { segment_seq } = z.object({ segment_seq: z.number().int() }).parse(input);
        const rows = await sql`
          SELECT rule_id, rule_class, result, measured, thresholds, confidence,
                 explanation, is_hard_stop, source_record_ids
          FROM rule_evaluations
          WHERE snapshot_id = ${ctx.snapshotId} AND segment_seq = ${segment_seq}
          ORDER BY rule_id
        `;
        if (rows.length === 0) return `no rule evaluations for segment ${segment_seq}`;
        const idToTag = new Map(ctx.sourceIndex.map((s) => [s.sourceRecordId, s.tag]));
        return rows
          .map((r) => {
            const ids = Array.isArray(r.source_record_ids) ? r.source_record_ids : [];
            const tags = ids
              .map((id) => idToTag.get(id as string))
              .filter((t) => t !== undefined)
              .map((t) => `[src:${t}]`)
              .join("");
            return `${r.rule_id} [${r.rule_class}] -> ${r.result}${r.is_hard_stop ? " HARD STOP" : ""} (confidence ${r.confidence}): ${r.explanation} | measured ${JSON.stringify(r.measured)} | limits ${JSON.stringify(r.thresholds)} ${tags}`;
          })
          .join("\n");
      },
    },
    {
      name: "list_recent_briefings",
      description:
        "Recent stored briefings for the same route (newest first): snapshot id, created time, overall rating. Use with diff_vs_briefing to explain what changed.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const rows = await sql`
          SELECT b.id, b.created_at, b.status, b.trip_summary->>'worstRating' AS worst
          FROM briefing_snapshots b
          WHERE b.request->'waypoints' = (
            SELECT request->'waypoints' FROM briefing_snapshots WHERE id = ${ctx.snapshotId}
          )
          ORDER BY b.created_at DESC LIMIT 8
        `;
        return rows
          .map(
            (r) =>
              `${r.id}${r.id === ctx.snapshotId ? " (this briefing)" : ""} · ${new Date(r.created_at as string).toISOString()} · ${String(r.worst).toUpperCase()} · ${r.status}`,
          )
          .join("\n");
      },
    },
    {
      name: "diff_vs_briefing",
      description:
        "Deterministic comparison of THIS briefing against an earlier snapshot id: rating flips, new/cleared hard stops, arrival shift, and which source products changed.",
      inputSchema: {
        type: "object",
        properties: { previous_snapshot_id: { type: "string" } },
        required: ["previous_snapshot_id"],
      },
      async run(input) {
        const { previous_snapshot_id } = z
          .object({ previous_snapshot_id: z.string().uuid() })
          .parse(input);
        const diff = await diffBriefings(sql, previous_snapshot_id, ctx.snapshotId);
        if (!diff) return "error: no such earlier briefing";
        return JSON.stringify(diff, null, 1);
      },
    },
  ];
}
