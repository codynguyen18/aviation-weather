"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// New Flight Plan (PLAN.md §15.1). Direct-leg planning — the inline note
// makes clear this is a planned track, not an ATC clearance. Signed-in users
// can save/load aircraft profiles, minimums profiles, and whole plans.

interface WaypointRow {
  ident: string;
  isFuelStop: boolean;
  groundMinutes: number;
}

interface SavedAircraft {
  id: string; name: string;
  performance: { cruiseTasKt: number; climbRateFpm: number; climbTasKt: number; descentRateFpm: number; descentTasKt: number };
  limits: { fuelEnduranceMin: number };
}
interface SavedMinimums { id: string; name: string; minimums: Record<string, unknown> }
interface SavedPlan {
  id: string; name: string;
  request: {
    waypoints: WaypointRow[];
    cruiseAltitudeFt: number;
    performance: { cruiseTasKt: number };
    minimums: Record<string, unknown>;
    aircraft: { fuelEnduranceMin: number };
  };
}

export default function PlanForm() {
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

  // Saved building blocks (M9).
  const [savedAircraft, setSavedAircraft] = useState<SavedAircraft[]>([]);
  const [savedMinimums, setSavedMinimums] = useState<SavedMinimums[]>([]);
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>([]);
  const loadSaved = () => {
    fetch("/api/profiles/aircraft").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSavedAircraft(d.profiles)).catch(() => {});
    fetch("/api/profiles/minimums").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSavedMinimums(d.profiles)).catch(() => {});
    fetch("/api/plans").then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSavedPlans(d.plans)).catch(() => {});
  };
  useEffect(loadSaved, []);

  const currentRequest = () => ({
    waypoints: waypoints
      .filter((w) => w.ident.trim() !== "")
      .map((w) => ({ ...w, ident: w.ident.trim().toUpperCase() })),
    departureTimeUtc: departureLocal
      ? new Date(departureLocal).toISOString()
      : new Date().toISOString(),
    cruiseAltitudeFt,
    performance: {
      cruiseTasKt, climbRateFpm: 900, climbTasKt: 130,
      descentRateFpm: 500, descentTasKt: 140,
    },
    minimums,
    aircraft: { fuelEnduranceMin },
  });

  async function saveNamed(url: string, payload: Record<string, unknown>, kind: string) {
    const name = prompt(`Name this ${kind}:`);
    if (!name?.trim()) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), ...payload }),
    }).catch(() => null);
    if (res?.ok) loadSaved();
    else alert("save failed");
  }

  const applyPlan = (p: SavedPlan) => {
    const r = p.request;
    setWaypoints(
      r.waypoints.map((w) => ({
        ident: w.ident, isFuelStop: Boolean(w.isFuelStop), groundMinutes: w.groundMinutes ?? 45,
      })),
    );
    setCruiseAltitudeFt(r.cruiseAltitudeFt);
    setCruiseTasKt(r.performance.cruiseTasKt);
    setFuelEnduranceMin(r.aircraft.fuelEnduranceMin);
    setMinimums((m) => ({ ...m, ...(r.minimums as typeof m) }));
  };

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
      // The response is usually JSON, but a serverless timeout returns a plain
      // "An error occurred" page — read as text first and parse defensively.
      const rawText = await res.text();
      let body: {
        error?: string; snapshotId?: string;
        detail?: { candidates?: unknown };
        problems?: { ident: string; status: string; candidates?: { ident: string; name: string; kind: string }[] }[];
      } = {};
      try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = {}; }

      if (!res.ok) {
        if (body.detail?.candidates) setProblems([body.detail as { ident: string; status: string; candidates?: { ident: string; name: string; kind: string }[] }]);
        else if (Array.isArray(body.problems)) setProblems(body.problems);

        if (res.status === 429) {
          setError(body.error ?? "You've hit the hourly briefing limit — try again shortly.");
        } else if (!body.error && (res.status === 502 || res.status === 504 || res.status >= 500)) {
          setError(
            "This route was too long for the free hosting tier to finish in time (it timed out gathering weather across the whole route). Try a shorter leg, or add a fuel-stop waypoint in the middle to break it up.",
          );
        } else {
          setError(body.error ?? `request failed (${res.status})`);
        }
        return;
      }
      router.push(`/briefing/${body.snapshotId}`);
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
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

      {savedPlans.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 13 }}>Load a saved plan:</span>
          <select
            defaultValue=""
            onChange={(e) => {
              const p = savedPlans.find((x) => x.id === e.target.value);
              if (p) applyPlan(p);
              e.target.value = "";
            }}
          >
            <option value="" disabled>choose…</option>
            {savedPlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Route
          <button
            style={{ marginLeft: "auto", fontSize: 12 }}
            onClick={() => saveNamed("/api/plans", { request: currentRequest() }, "flight plan")}
            disabled={waypoints.filter((w) => w.ident.trim() !== "").length < 2}
          >
            save plan
          </button>
        </h3>
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
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Time & aircraft
          {savedAircraft.length > 0 && (
            <select
              defaultValue=""
              style={{ marginLeft: "auto", fontSize: 12 }}
              onChange={(e) => {
                const p = savedAircraft.find((x) => x.id === e.target.value);
                if (p) {
                  setCruiseTasKt(p.performance.cruiseTasKt);
                  setFuelEnduranceMin(p.limits.fuelEnduranceMin);
                }
                e.target.value = "";
              }}
            >
              <option value="" disabled>load aircraft…</option>
              {savedAircraft.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button
            style={{ marginLeft: savedAircraft.length > 0 ? 0 : "auto", fontSize: 12 }}
            onClick={() =>
              saveNamed(
                "/api/profiles/aircraft",
                {
                  performance: {
                    cruiseTasKt, climbRateFpm: 900, climbTasKt: 130,
                    descentRateFpm: 500, descentTasKt: 140,
                  },
                  limits: { fuelEnduranceMin },
                },
                "aircraft profile",
              )
            }
          >
            save aircraft
          </button>
        </h3>
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
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          Personal minimums <span className="muted" style={{ fontWeight: 400 }}>(hard limits — violations always show red)</span>
          {savedMinimums.length > 0 && (
            <select
              defaultValue=""
              style={{ marginLeft: "auto", fontSize: 12 }}
              onChange={(e) => {
                const p = savedMinimums.find((x) => x.id === e.target.value);
                if (p) setMinimums((m) => ({ ...m, ...(p.minimums as typeof m) }));
                e.target.value = "";
              }}
            >
              <option value="" disabled>load minimums…</option>
              {savedMinimums.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button
            style={{ marginLeft: savedMinimums.length > 0 ? 0 : "auto", fontSize: 12 }}
            onClick={() => saveNamed("/api/profiles/minimums", { minimums }, "minimums profile")}
          >
            save minimums
          </button>
        </h3>
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
