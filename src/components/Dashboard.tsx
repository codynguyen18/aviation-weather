"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import ChatPanel from "@/components/ChatPanel";
import RouteMap from "@/components/RouteMap";
import Timeline from "@/components/Timeline";
import SegmentDetail from "@/components/SegmentDetail";
import InspectorModal from "@/components/InspectorModal";
import type { RouteModel } from "@/lib/route/types";

export interface DashboardData {
  snapshot: {
    id: string;
    created_at: string;
    status: string;
    partial_reasons: string[];
    request: Record<string, unknown>;
    route: RouteModel;
    trip_summary: {
      worstRating: string;
      counts: Record<string, number>;
      hardStops: string[];
      unknownSegments: number[];
    };
  };
  assessments: {
    segment_seq: number;
    rating: string;
    confidence: string;
    summary: string;
    hard_stops: string[];
  }[];
  evaluations: {
    segment_seq: number;
    rule_id: string;
    rule_class: string;
    result: string;
    measured: Record<string, unknown>;
    thresholds: Record<string, unknown>;
    confidence: string;
    explanation: string;
    is_hard_stop: boolean;
    source_record_ids: string[];
  }[];
}

const ratingLabel: Record<string, string> = {
  green: "Green — favorable within your limits",
  yellow: "Yellow — meaningful hazards; margin required",
  red: "Red — conflicts with a hard limit or unacceptable exposure",
  unknown: "Unknown — required information missing or stale",
};

export default function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { snapshot, assessments, evaluations } = data;
  const route = snapshot.route;
  const trip = snapshot.trip_summary;
  const ratingBySeq = new Map(assessments.map((a) => [a.segment_seq, a.rating]));

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/briefings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot.request),
      });
      const body = await res.json();
      if (res.ok) router.push(`/briefing/${body.snapshotId}?prev=${snapshot.id}`);
      else alert(body.error ?? "refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  const ageMin = Math.round((Date.now() - Date.parse(snapshot.created_at)) / 60_000);

  return (
    <main style={{ display: "grid", gap: 10, padding: 12, gridTemplateColumns: "1fr", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span
          className={`badge rating-${trip.worstRating}`}
          title={ratingLabel[trip.worstRating]}
          style={{ fontSize: 14, padding: "4px 12px" }}
        >
          Trip: {trip.worstRating.toUpperCase()}
        </span>
        <span className="muted">
          {trip.counts.green} green · {trip.counts.yellow} yellow · {trip.counts.red} red · {trip.counts.unknown} unknown
        </span>
        <span className="muted mono">
          briefed {ageMin < 90 ? `${ageMin} min ago` : new Date(snapshot.created_at).toISOString().slice(0, 16) + "Z"}
        </span>
        <button className="primary" onClick={refresh} disabled={refreshing} style={{ marginLeft: "auto" }}>
          {refreshing ? "Refreshing…" : "↻ Refresh briefing"}
        </button>
      </div>

      {snapshot.status === "partial" && (
        <div className="partial-banner">
          <b>Partial briefing.</b> Some weather sources were unavailable — affected
          segments are rated Unknown, not assumed clear:{" "}
          {snapshot.partial_reasons.join(" · ")}
        </div>
      )}

      {trip.hardStops.length > 0 && (
        <div className="partial-banner">
          <b>Hard stops:</b>
          <ul style={{ margin: "4px 0 0 18px" }}>
            {[...new Set(trip.hardStops)].slice(0, 6).map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: selectedSeq === null ? "1fr" : "2fr 1fr", gap: 10 }}>
        <div style={{ display: "grid", gap: 10 }}>
          <RouteMap
            route={route}
            snapshotId={snapshot.id}
            ratingBySeq={ratingBySeq}
            selectedSeq={selectedSeq}
            onSelect={setSelectedSeq}
          />
          <Timeline
            route={route}
            ratingBySeq={ratingBySeq}
            selectedSeq={selectedSeq}
            onSelect={setSelectedSeq}
          />
        </div>
        {selectedSeq !== null && (
          <SegmentDetail
            segment={route.segments.find((s) => s.seq === selectedSeq)!}
            assessment={assessments.find((a) => a.segment_seq === selectedSeq)!}
            evaluations={evaluations.filter((e) => e.segment_seq === selectedSeq)}
            onClose={() => setSelectedSeq(null)}
            onInspect={setInspectId}
          />
        )}
      </div>

      <ChatPanel snapshotId={snapshot.id} onInspect={setInspectId} />

      <div className="advisory-banner">
        Advisory only — not an official weather briefing. Ratings reflect the
        listed sources at the times shown; verify with Flight Service / an
        official briefing before flight. Unknown is never treated as clear.
      </div>

      {inspectId && (
        <InspectorModal recordId={inspectId} onClose={() => setInspectId(null)} />
      )}
    </main>
  );
}
