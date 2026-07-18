import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { sql } from "@/db";
import { diffBriefings } from "@/lib/briefing/diff";

export const dynamic = "force-dynamic";

// What-changed view (PLAN.md §15.8): the newer briefing vs the older one —
// rating flips, hard stops appearing/clearing, ETA shifts, and the source
// evidence that changed underneath.
export default async function DiffPage(props: {
  params: Promise<{ id: string; prevId: string }>;
}) {
  const { id, prevId } = await props.params;
  const uuid = z.string().uuid();
  if (!uuid.safeParse(id).success || !uuid.safeParse(prevId).success) notFound();

  const diff = await diffBriefings(sql, prevId, id);
  if (!diff) notFound();

  return (
    <main style={{ maxWidth: 860, margin: "1.5rem auto", padding: "0 16px", display: "grid", gap: 12 }}>
      <h1>What changed?</h1>
      <div className="muted mono">
        {diff.fromCreatedAt.slice(0, 16)}Z → {diff.toCreatedAt.slice(0, 16)}Z
        {" · "}
        <Link href={`/briefing/${prevId}`}>older briefing</Link>
        {" · "}
        <Link href={`/briefing/${id}`}>newer briefing</Link>
      </div>

      {!diff.sameRoute && (
        <div className="partial-banner">
          These briefings are for different routes — segment-by-segment
          comparison is not shown.
        </div>
      )}

      <section className="panel" style={{ display: "grid", gap: 6 }}>
        <div>
          Overall:{" "}
          <span className={`badge rating-${diff.worstRating.from}`}>{diff.worstRating.from.toUpperCase()}</span>
          {" → "}
          <span className={`badge rating-${diff.worstRating.to}`}>{diff.worstRating.to.toUpperCase()}</span>
          {diff.worstRating.from === diff.worstRating.to && (
            <span className="muted"> (unchanged)</span>
          )}
        </div>
        <div className="muted">
          Arrival {diff.arrivalShiftMin === 0
            ? "unchanged"
            : `${Math.abs(diff.arrivalShiftMin)} min ${diff.arrivalShiftMin > 0 ? "later" : "earlier"}`}
          {" "}({diff.arrivalTo.slice(11, 16)}Z)
        </div>
        {diff.statusChange && (
          <div className="muted">
            Coverage: {diff.statusChange.from} → {diff.statusChange.to}
          </div>
        )}
      </section>

      {diff.newHardStops.length > 0 && (
        <section className="partial-banner">
          <b>New hard stops:</b>
          <ul style={{ margin: "4px 0 0 18px" }}>
            {diff.newHardStops.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </section>
      )}
      {diff.clearedHardStops.length > 0 && (
        <section className="panel">
          <b>Cleared hard stops:</b>
          <ul style={{ margin: "4px 0 0 18px" }} className="muted">
            {diff.clearedHardStops.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </section>
      )}

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <h3>Segment rating changes</h3>
        {diff.ratingChanges.length === 0 && (
          <span className="muted">No segment changed its rating.</span>
        )}
        {diff.ratingChanges.map((c) => (
          <div key={c.segmentSeq} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="mono">{c.startIdent} → {c.endIdent}</span>
            <span className={`badge rating-${c.from}`}>{c.from}</span>
            <span>→</span>
            <span className={`badge rating-${c.to}`}>{c.to}</span>
            <span className="muted" style={{ fontSize: 13 }}>{c.toSummary}</span>
          </div>
        ))}
      </section>

      <section className="panel" style={{ display: "grid", gap: 6 }}>
        <h3>Source evidence changes</h3>
        {diff.sourceDeltas.length === 0 && (
          <span className="muted">Same underlying products in both briefings.</span>
        )}
        {diff.sourceDeltas.map((d) => (
          <div key={d.sourceType} className="mono" style={{ fontSize: 13 }}>
            <b>{d.sourceType}</b>: {d.added} new{d.removed > 0 ? `, ${d.removed} superseded` : ""}
            {d.examplesAdded.length > 0 && (
              <span className="muted"> — e.g. {d.examplesAdded.join("; ")}</span>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
