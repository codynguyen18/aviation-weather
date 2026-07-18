"use client";

import type { RouteModel } from "@/lib/route/types";

// Timeline strip (PLAN.md §15.2): the trip by clock time — rating-colored
// blocks, fuel stops, and day/twilight/night shading at a glance.

export default function Timeline(props: {
  route: RouteModel;
  ratingBySeq: Map<number, string>;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  const { route, ratingBySeq, selectedSeq, onSelect } = props;
  const total = route.segments.reduce(
    (a, s) => a + (Date.parse(s.time.exitUtc) - Date.parse(s.time.entryUtc)), 0,
  ) + route.groundStops.reduce((a, g) => a + g.groundMinutes * 60_000, 0);

  const stopAfter = new Map(
    route.groundStops.map((g) => [g.ident, g.groundMinutes]),
  );

  return (
    <div className="panel" style={{ padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <b>Timeline</b>
        <span className="muted mono">
          {route.totals.departureUtc.slice(11, 16)}Z →{" "}
          {route.totals.arrivalLocal} ({route.totals.arrivalDaylight})
        </span>
      </div>
      <div style={{ display: "flex", width: "100%", height: 34, borderRadius: 6, overflow: "hidden" }}>
        {route.segments.map((s) => {
          const ms = Date.parse(s.time.exitUtc) - Date.parse(s.time.entryUtc);
          const rating = ratingBySeq.get(s.seq) ?? "unknown";
          const night = s.time.exitDaylight !== "day";
          const stopMin = stopAfter.get(s.endIdent);
          return (
            <div key={s.seq} style={{ display: "flex", flexGrow: ms, minWidth: 0 }}>
              <div
                className={`rating-${rating}`}
                onClick={() => onSelect(s.seq)}
                title={`${s.startIdent} → ${s.endIdent}\n${s.time.entryLocal} – ${s.time.exitLocal}\n${rating.toUpperCase()}`}
                style={{
                  flex: 1, cursor: "pointer", position: "relative",
                  outline: selectedSeq === s.seq ? "2px solid #fff" : "none",
                  outlineOffset: -2,
                  opacity: night ? 0.65 : 1,
                }}
              >
                {night && (
                  <span style={{ position: "absolute", top: 1, right: 3, fontSize: 10 }}>🌙</span>
                )}
              </div>
              {stopMin !== undefined && (
                <div
                  title={`Fuel stop ${s.endIdent} (${stopMin} min)`}
                  style={{
                    width: 10, background: "#33415a",
                    borderLeft: "1px solid #0b0f14", borderRight: "1px solid #0b0f14",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }} className="muted mono">
        <span>{route.waypoints[0]?.ident}</span>
        <span>
          {Math.round(total / 3_600_000 * 10) / 10} h total ·{" "}
          {route.engine.wind === "fb-winds" ? "wind-adjusted ETAs" : "zero-wind ETAs (winds unavailable)"}
        </span>
        <span>{route.waypoints[route.waypoints.length - 1]?.ident}</span>
      </div>
    </div>
  );
}
