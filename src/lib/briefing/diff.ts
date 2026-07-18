import type { Sql } from "postgres";

// Deterministic briefing diff (PLAN.md §12.5): computed entirely from stored
// snapshots — the LLM explains it but never computes it. "What changed since
// the last update?" is answered from this object with both snapshot ids.

export interface RatingChange {
  segmentSeq: number;
  startIdent: string;
  endIdent: string;
  from: string;
  to: string;
  toSummary: string;
}

export interface SourceDelta {
  sourceType: string;
  added: number;
  removed: number;
  examplesAdded: string[]; // "TAF KRKS issued 18:20Z"
}

export interface BriefingDiff {
  fromId: string;
  toId: string;
  fromCreatedAt: string;
  toCreatedAt: string;
  sameRoute: boolean;
  worstRating: { from: string; to: string };
  statusChange: { from: string; to: string } | null;
  ratingChanges: RatingChange[];
  newHardStops: string[];
  clearedHardStops: string[];
  arrivalShiftMin: number; // positive = later arrival in the newer briefing
  arrivalFrom: string;
  arrivalTo: string;
  sourceDeltas: SourceDelta[];
}

interface SnapRow {
  id: string;
  created_at: string;
  status: string;
  request: { waypoints?: { ident: string }[] };
  route: {
    totals: { arrivalUtc: string };
    segments: { seq: number; startIdent: string; endIdent: string }[];
  };
  trip_summary: { worstRating: string; hardStops: string[] };
}

export async function diffBriefings(
  sql: Sql,
  fromId: string,
  toId: string,
): Promise<BriefingDiff | null> {
  const rows = await sql`
    SELECT id, created_at, status, request, route, trip_summary
    FROM briefing_snapshots WHERE id IN (${fromId}, ${toId})
  `;
  const from = rows.find((r) => r.id === fromId) as unknown as SnapRow | undefined;
  const to = rows.find((r) => r.id === toId) as unknown as SnapRow | undefined;
  if (!from || !to) return null;

  const wp = (s: SnapRow) => (s.request.waypoints ?? []).map((w) => w.ident).join(">");
  const sameRoute = wp(from) === wp(to);

  const fromAssess = await sql`
    SELECT segment_seq, rating, summary FROM segment_assessments
    WHERE snapshot_id = ${fromId} ORDER BY segment_seq
  `;
  const toAssess = await sql`
    SELECT segment_seq, rating, summary FROM segment_assessments
    WHERE snapshot_id = ${toId} ORDER BY segment_seq
  `;
  const fromBySeq = new Map(fromAssess.map((a) => [Number(a.segment_seq), a]));
  const ratingChanges: RatingChange[] = [];
  if (sameRoute) {
    for (const a of toAssess) {
      const seq = Number(a.segment_seq);
      const prev = fromBySeq.get(seq);
      if (prev && prev.rating !== a.rating) {
        const seg = to.route.segments.find((s) => s.seq === seq);
        ratingChanges.push({
          segmentSeq: seq,
          startIdent: seg?.startIdent ?? String(seq),
          endIdent: seg?.endIdent ?? "",
          from: prev.rating as string,
          to: a.rating as string,
          toSummary: a.summary as string,
        });
      }
    }
  }

  const fromStops = new Set(from.trip_summary.hardStops ?? []);
  const toStops = new Set(to.trip_summary.hardStops ?? []);
  const newHardStops = [...toStops].filter((h) => !fromStops.has(h));
  const clearedHardStops = [...fromStops].filter((h) => !toStops.has(h));

  // Source-evidence delta: which product records back the new briefing but
  // not the old, and vice versa.
  const linkRows = await sql`
    SELECT l.snapshot_id, s.source_type, s.station, s.issued_at, s.external_key
    FROM briefing_source_links l
    JOIN source_records s ON s.id = l.source_record_id
    WHERE l.snapshot_id IN (${fromId}, ${toId})
  `;
  const fromKeys = new Set(
    linkRows.filter((r) => r.snapshot_id === fromId).map((r) => r.external_key as string),
  );
  const toKeys = new Set(
    linkRows.filter((r) => r.snapshot_id === toId).map((r) => r.external_key as string),
  );
  const byType = new Map<string, SourceDelta>();
  for (const r of linkRows) {
    const type = r.source_type as string;
    let d = byType.get(type);
    if (!d) {
      d = { sourceType: type, added: 0, removed: 0, examplesAdded: [] };
      byType.set(type, d);
    }
    const key = r.external_key as string;
    if (r.snapshot_id === toId && !fromKeys.has(key)) {
      d.added += 1;
      if (d.examplesAdded.length < 3) {
        const t = r.issued_at ? new Date(r.issued_at as string).toISOString().slice(11, 16) + "Z" : "";
        d.examplesAdded.push(`${type} ${r.station ?? ""} ${t}`.trim());
      }
    }
    if (r.snapshot_id === fromId && !toKeys.has(key)) d.removed += 1;
  }

  return {
    fromId,
    toId,
    fromCreatedAt: new Date(from.created_at).toISOString(),
    toCreatedAt: new Date(to.created_at).toISOString(),
    sameRoute,
    worstRating: {
      from: from.trip_summary.worstRating,
      to: to.trip_summary.worstRating,
    },
    statusChange: from.status !== to.status ? { from: from.status, to: to.status } : null,
    ratingChanges,
    newHardStops,
    clearedHardStops,
    arrivalShiftMin: Math.round(
      (Date.parse(to.route.totals.arrivalUtc) - Date.parse(from.route.totals.arrivalUtc)) / 60_000,
    ),
    arrivalFrom: from.route.totals.arrivalUtc,
    arrivalTo: to.route.totals.arrivalUtc,
    sourceDeltas: [...byType.values()].filter((d) => d.added > 0 || d.removed > 0),
  };
}
