"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// New Flight Plan (PLAN.md §15.1). Direct-leg planning — the inline note
// makes clear this is a planned track, not an ATC clearance.

interface WaypointRow {
  ident: string;
  isFuelStop: boolean;
  groundMinutes: number;
}

export default function PlanPage() {
  const router = useRouter();
  const [waypoints, setWaypoints] = useState<WaypointRow[]>([
    { ident: "", isFuelStop: false, groundMinutes: 45 },
    { ident: "", isFuelStop: false, groundMinutes: 45 },
  ]);
  const [departureLocal, setDepartureLocal] = useState("");
  const [cruiseAltitudeFt, setCruiseAltitudeFt] = useState(10500);
  const [cruiseTasKt, setCruiseTasKt] = useState(165);
  const [fuelEnduranceMin, setFuelEnduranceMin] = useState(300);
  const [minimums, setMinimums] = useState({
    mode: "ifr", minCeilingFt: 800, minVisibilitySm: 2,
    maxSurfaceWindKt: 25, maxCrosswindKt: 15, maxWindsAloftKt: 45,
    nightOk: false, maxDutyMin: 840, fuelReserveMin: 60,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ ident: string; status: string; candidates?: { ident: string; name: string; kind: string }[] }[]>([]);

  const setWp = (i: number, patch: Partial<WaypointRow>) =>
    setWaypoints((w) => w.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  async function submit() {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const departureTimeUtc = new Date(departureLocal).toISOString();
      const res = await fetch("/api/briefings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waypoints: waypoints
            .filter((w) => w.ident.trim() !== "")
            .map((w) => ({ ...w, ident: w.ident.trim().toUpperCase() })),
          departureTimeUtc,
          cruiseAltitudeFt,
          performance: {
            cruiseTasKt, climbRateFpm: 900, climbTasKt: 130,
            descentRateFpm: 500, descentTasKt: 140,
          },
          minimums,
          aircraft: { fuelEnduranceMin },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.detail?.candidates) setProblems([body.detail]);
        else if (Array.isArray(body.problems)) setProblems(body.problems);
        setError(body.error ?? `request failed (${res.status})`);
        return;
      }
      router.push(`/briefing/${body.snapshotId}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    departureLocal !== "" &&
    waypoints.filter((w) => w.ident.trim() !== "").length >= 2;

  return (
    <main style={{ maxWidth: 860, margin: "1.5rem auto", padding: "0 16px", display: "grid", gap: 14 }}>
      <h1>New flight plan</h1>
      <div className="advisory-banner">
        Routes are planned as <b>direct legs</b> between the waypoints you
        enter — this is a planning track, not an ATC-cleared route. Enter the
        waypoints you actually intend to fly, especially in mountains.
      </div>

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <h3>Route</h3>
        {waypoints.map((w, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              placeholder={i === 0 ? "Departure (e.g. KSTL)" : i === waypoints.length - 1 ? "Destination (e.g. KOAK)" : "Waypoint"}
              value={w.ident}
              onChange={(e) => setWp(i, { ident: e.target.value })}
              style={{ width: 200 }}
            />
            {i > 0 && i < waypoints.length - 1 && (
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="checkbox" checked={w.isFuelStop}
                  onChange={(e) => setWp(i, { isFuelStop: e.target.checked })} />
                fuel stop
                {w.isFuelStop && (
                  <>
                    <input type="number" value={w.groundMinutes} min={0} max={1440}
                      onChange={(e) => setWp(i, { groundMinutes: Number(e.target.value) })}
                      style={{ width: 70 }} /> min
                  </>
                )}
              </label>
            )}
            {waypoints.length > 2 && (
              <button onClick={() => setWaypoints((ws) => ws.filter((_, j) => j !== i))}>✕</button>
            )}
          </div>
        ))}
        <div>
          <button onClick={() =>
            setWaypoints((ws) => [...ws.slice(0, -1), { ident: "", isFuelStop: false, groundMinutes: 45 }, ws[ws.length - 1]!])
          }>+ add waypoint</button>
        </div>
      </section>

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <h3>Time & aircraft</h3>
        <label>Departure (your local time) {" "}
          <input type="datetime-local" value={departureLocal}
            onChange={(e) => setDepartureLocal(e.target.value)} />
          {departureLocal && (
            <span className="muted mono" style={{ marginLeft: 8 }}>
              = {new Date(departureLocal).toISOString().slice(0, 16)}Z
            </span>
          )}
        </label>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label>Cruise altitude (ft) <input type="number" value={cruiseAltitudeFt} step={500}
            onChange={(e) => setCruiseAltitudeFt(Number(e.target.value))} style={{ width: 100 }} /></label>
          <label>Cruise TAS (kt) <input type="number" value={cruiseTasKt}
            onChange={(e) => setCruiseTasKt(Number(e.target.value))} style={{ width: 80 }} /></label>
          <label>Fuel endurance (min) <input type="number" value={fuelEnduranceMin} step={15}
            onChange={(e) => setFuelEnduranceMin(Number(e.target.value))} style={{ width: 90 }} /></label>
        </div>
      </section>

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <h3>Personal minimums <span className="muted" style={{ fontWeight: 400 }}>(hard limits — violations always show red)</span></h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label>Mode {" "}
            <select value={minimums.mode} onChange={(e) => setMinimums((m) => ({ ...m, mode: e.target.value }))}>
              <option value="ifr">IFR</option>
              <option value="vfr">VFR</option>
            </select>
          </label>
          <label>Min ceiling (ft) <input type="number" value={minimums.minCeilingFt} step={100}
            onChange={(e) => setMinimums((m) => ({ ...m, minCeilingFt: Number(e.target.value) }))} style={{ width: 90 }} /></label>
          <label>Min visibility (sm) <input type="number" value={minimums.minVisibilitySm} step={0.5}
            onChange={(e) => setMinimums((m) => ({ ...m, minVisibilitySm: Number(e.target.value) }))} style={{ width: 70 }} /></label>
          <label>Max surface wind (kt) <input type="number" value={minimums.maxSurfaceWindKt}
            onChange={(e) => setMinimums((m) => ({ ...m, maxSurfaceWindKt: Number(e.target.value) }))} style={{ width: 70 }} /></label>
          <label>Max crosswind (kt) <input type="number" value={minimums.maxCrosswindKt}
            onChange={(e) => setMinimums((m) => ({ ...m, maxCrosswindKt: Number(e.target.value) }))} style={{ width: 70 }} /></label>
          <label>Max winds aloft (kt) <input type="number" value={minimums.maxWindsAloftKt}
            onChange={(e) => setMinimums((m) => ({ ...m, maxWindsAloftKt: Number(e.target.value) }))} style={{ width: 70 }} /></label>
          <label>Fuel reserve (min) <input type="number" value={minimums.fuelReserveMin} step={15}
            onChange={(e) => setMinimums((m) => ({ ...m, fuelReserveMin: Number(e.target.value) }))} style={{ width: 70 }} /></label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={minimums.nightOk}
              onChange={(e) => setMinimums((m) => ({ ...m, nightOk: e.target.checked }))} />
            night flying OK
          </label>
        </div>
      </section>

      {error && (
        <div className="partial-banner">
          {error}
          {problems.map((p) => (
            <div key={p.ident} style={{ marginTop: 6 }}>
              <b>{p.ident}</b>: {p.status}
              {p.candidates && (
                <span> — did you mean {p.candidates.slice(0, 4).map((c) => `${c.ident} (${c.name})`).join(", ")}?</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <button className="primary" disabled={!canSubmit} onClick={submit}>
          {busy ? "Gathering weather & evaluating…" : "Generate briefing"}
        </button>
        <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
          Fetches live METARs, TAFs, PIREPs, SIGMETs, G-AIRMETs, CWAs, winds aloft, and forecast discussions.
        </span>
      </div>
    </main>
  );
}
