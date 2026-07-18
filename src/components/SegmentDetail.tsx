"use client";

import type { RouteSegment } from "@/lib/route/types";

// Segment detail drawer (PLAN.md §15.3): why this segment got its color —
// every rule that ran, measured values vs thresholds, and click-through to
// the raw source evidence.

interface Assessment {
  rating: string;
  confidence: string;
  summary: string;
  hard_stops: string[];
}

interface Evaluation {
  rule_id: string;
  rule_class: string;
  result: string;
  measured: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  confidence: string;
  explanation: string;
  is_hard_stop: boolean;
  source_record_ids: string[];
}

const resultColor: Record<string, string> = {
  pass: "var(--green)", yellow: "var(--yellow)", red: "var(--red)",
  unknown: "var(--unknown)", "not-applicable": "var(--muted)",
};

export default function SegmentDetail(props: {
  segment: RouteSegment;
  assessment: Assessment;
  evaluations: Evaluation[];
  onClose: () => void;
  onInspect: (recordId: string) => void;
}) {
  const { segment: s, assessment, evaluations, onClose, onInspect } = props;
  return (
    <div className="panel" style={{ display: "grid", gap: 10, alignSelf: "start", maxHeight: 640, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`badge rating-${assessment.rating}`}>{assessment.rating.toUpperCase()}</span>
        <b>{s.startIdent} → {s.endIdent}</b>
        <button onClick={onClose} style={{ marginLeft: "auto" }}>✕</button>
      </div>

      <div className="mono muted" style={{ display: "grid", gap: 2 }}>
        <span>{s.time.entryLocal} → {s.time.exitLocal}</span>
        <span>{s.time.entryUtc.slice(11, 16)}Z → {s.time.exitUtc.slice(11, 16)}Z · {s.time.exitDaylight}</span>
        <span>{Math.round(s.distanceNm)} nm · {s.altitudeFt} ft · {s.phase} · GS {Math.round(s.groundspeedKt)} kt</span>
        <span>
          {s.windSource === "fb"
            ? `wind ${s.windDirDeg ?? "VRB"}°/${s.windSpeedKt} kt (${s.windStation}) — ${s.headwindKt! >= 0 ? "headwind" : "tailwind"} ${Math.abs(s.headwindKt!)} kt`
            : "winds aloft unavailable for this segment"}
        </span>
      </div>

      <div>{assessment.summary}</div>
      <div className="muted" style={{ fontSize: 12 }}>confidence: {assessment.confidence}</div>

      <div style={{ display: "grid", gap: 8 }}>
        {evaluations.map((e, i) => (
          <div key={i} style={{ borderLeft: `3px solid ${resultColor[e.result] ?? "var(--muted)"}`, paddingLeft: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <b className="mono">{e.rule_id}</b>
              <span className="muted" style={{ fontSize: 11 }}>
                {e.rule_class === "hard-limit" ? "your minimum" : "app heuristic"} · {e.result}
                {e.is_hard_stop ? " · HARD STOP" : ""}
              </span>
            </div>
            <div style={{ fontSize: 13 }}>{e.explanation}</div>
            {(Object.keys(e.measured).length > 0 || Object.keys(e.thresholds).length > 0) && (
              <div className="mono muted" style={{ fontSize: 11.5 }}>
                measured {JSON.stringify(e.measured)} · limits {JSON.stringify(e.thresholds)}
              </div>
            )}
            {e.source_record_ids.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                {e.source_record_ids.slice(0, 6).map((id) => (
                  <button
                    key={id}
                    onClick={() => onInspect(id)}
                    style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999 }}
                    title="view raw source"
                  >
                    source ⧉
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {evaluations.length === 0 && (
          <div className="muted">No rules fired for this segment.</div>
        )}
      </div>
    </div>
  );
}
