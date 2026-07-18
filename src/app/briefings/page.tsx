import Link from "next/link";

import { sql } from "@/db";

export const dynamic = "force-dynamic";

// Saved briefing history (PLAN.md §15.7): snapshots newest-first with their
// rating strips; diffs arrive via the compare links.
export default async function BriefingsPage() {
  const rows = await sql`
    SELECT b.id, b.created_at, b.status, b.trip_summary,
           b.request->'waypoints' AS waypoints
    FROM briefing_snapshots b
    ORDER BY b.created_at DESC
    LIMIT 30
  `;

  return (
    <main style={{ maxWidth: 860, margin: "1.5rem auto", padding: "0 16px", display: "grid", gap: 10 }}>
      <h1>Briefing history</h1>
      {rows.length === 0 && (
        <p className="muted">No briefings yet — <Link href="/plan">plan a flight</Link>.</p>
      )}
      {rows.map((r, i) => {
        const trip = r.trip_summary as {
          worstRating: string;
          counts: Record<string, number>;
        };
        const wps = (r.waypoints as { ident: string }[]) ?? [];
        const routeLabel = wps.map((w) => w.ident).join(" → ");
        const prev = rows[i + 1];
        return (
          <div key={r.id as string} className="panel" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span className={`badge rating-${trip.worstRating}`}>{trip.worstRating.toUpperCase()}</span>
            <div style={{ display: "grid" }}>
              <Link href={`/briefing/${r.id}`}><b>{routeLabel}</b></Link>
              <span className="muted mono" style={{ fontSize: 12 }}>
                {new Date(r.created_at as string).toISOString().slice(0, 16)}Z
                {" · "}{trip.counts.green}g / {trip.counts.yellow}y / {trip.counts.red}r / {trip.counts.unknown}u
                {r.status === "partial" ? " · PARTIAL" : ""}
              </span>
            </div>
            {prev && (
              <Link
                href={`/briefing/${r.id}/diff/${prev.id}`}
                style={{ marginLeft: "auto", fontSize: 13 }}
              >
                what changed?
              </Link>
            )}
          </div>
        );
      })}
    </main>
  );
}
