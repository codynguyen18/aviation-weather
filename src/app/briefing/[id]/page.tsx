import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/auth";
import { sql } from "@/db";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

// Route Dashboard (PLAN.md §15.2): server-fetches the immutable snapshot and
// hands it to the interactive client dashboard. User-scoped at the query.
export default async function BriefingPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const [snap] = await sql`
    SELECT id, created_at, ruleset_version, engine_version, status,
           partial_reasons, request, route, trip_summary
    FROM briefing_snapshots WHERE id = ${id} AND user_id = ${session.user.id}
  `;
  if (!snap) notFound();

  const assessments = await sql`
    SELECT segment_seq, rating, confidence, summary, hard_stops
    FROM segment_assessments WHERE snapshot_id = ${id} ORDER BY segment_seq
  `;
  const evaluations = await sql`
    SELECT segment_seq, rule_id, rule_class, result, measured, thresholds,
           confidence, explanation, is_hard_stop, source_record_ids
    FROM rule_evaluations WHERE snapshot_id = ${id}
    ORDER BY segment_seq, is_hard_stop DESC, rule_id
  `;

  return (
    <Dashboard
      data={JSON.parse(JSON.stringify({
        snapshot: snap,
        assessments,
        evaluations,
      }))}
    />
  );
}
