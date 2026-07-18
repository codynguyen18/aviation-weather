"use client";

import { useEffect, useState } from "react";

// Weather-source inspector (PLAN.md §15.4): the verbatim upstream product
// next to its normalized reading, with issue/valid/fetched times and
// freshness. Everything the app claims traces to a record like this.

interface InspectorPayload {
  record: {
    source_type: string;
    station: string | null;
    issued_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
    fetched_at: string;
    upstream_url: string;
    raw: unknown;
    parse_status: string;
  };
  normalized: unknown;
  freshness: string;
}

export default function InspectorModal(props: {
  recordId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<InspectorPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/source-records/${props.recordId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [props.recordId]);

  const raw = data?.record.raw;
  const rawText =
    raw && typeof raw === "object" && "text" in (raw as Record<string, unknown>)
      ? String((raw as Record<string, unknown>).text)
      : JSON.stringify(raw, null, 2);

  return (
    <div
      onClick={props.onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "grid", placeItems: "center", zIndex: 50, padding: 20,
      }}
    >
      <div
        className="panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 760, width: "100%", maxHeight: "80vh", overflowY: "auto", display: "grid", gap: 10 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b>Source inspector</b>
          <button onClick={props.onClose} style={{ marginLeft: "auto" }}>✕</button>
        </div>
        {error && <div className="partial-banner">{error}</div>}
        {!data && !error && <div className="muted">Loading…</div>}
        {data && (
          <>
            <div className="mono" style={{ fontSize: 12.5, display: "grid", gap: 2 }}>
              <span>{data.record.source_type}{data.record.station ? ` · ${data.record.station}` : ""} · freshness: <b>{data.freshness}</b></span>
              <span className="muted">issued {data.record.issued_at ?? "—"} · valid {data.record.valid_from ?? "—"} → {data.record.valid_to ?? "—"}</span>
              <span className="muted">fetched {data.record.fetched_at}</span>
              <span className="muted" style={{ wordBreak: "break-all" }}>{data.record.upstream_url}</span>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Verbatim source</div>
              <pre className="mono" style={{
                background: "#0b0f14", padding: 10, borderRadius: 6,
                whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 300, overflowY: "auto",
              }}>{rawText}</pre>
            </div>
            {data.normalized !== null && (
              <div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Normalized reading</div>
                <pre className="mono" style={{
                  background: "#0b0f14", padding: 10, borderRadius: 6,
                  whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflowY: "auto",
                }}>{JSON.stringify(data.normalized, null, 2)}</pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
