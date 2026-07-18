import { greatCircleNm, intermediatePoint, type LatLon } from "@/lib/geo";
import { daylightAt } from "@/lib/route/daylight";
import { formatLocal, zoneFor } from "@/lib/route/timezone";
import type {
  FlightPhase,
  GroundStop,
  RouteModel,
  RouteOptions,
  RouteSegment,
  RouteWaypoint,
  SegmentTime,
} from "@/lib/route/types";

export const ENGINE_VERSION = "m2.0";

const DENSIFY_NM = 10;

// ---------------------------------------------------------------------------
// Speed/altitude profile for one "hop" (the airborne run between two ground
// contacts). Zero-wind in M2: groundspeed = TAS (PLAN.md §8.5; winds in M4).
// If the hop is too short to complete full climb + descent, both are scaled
// down proportionally and the hop never reaches cruise altitude.
// ---------------------------------------------------------------------------
interface HopProfile {
  climbDistNm: number;
  descentDistNm: number;
  topAltitudeFt: number;
  totalDistNm: number;
}

function hopProfile(
  totalDistNm: number,
  startElevFt: number,
  endElevFt: number,
  opts: RouteOptions,
): HopProfile {
  const p = opts.performance;
  const climbFt = Math.max(0, opts.cruiseAltitudeFt - startElevFt);
  const descentFt = Math.max(0, opts.cruiseAltitudeFt - endElevFt);
  let climbDistNm = (climbFt / p.climbRateFpm / 60) * p.climbTasKt;
  let descentDistNm = (descentFt / p.descentRateFpm / 60) * p.descentTasKt;
  let topAltitudeFt = opts.cruiseAltitudeFt;
  const needed = climbDistNm + descentDistNm;
  if (needed > totalDistNm && needed > 0) {
    const scale = totalDistNm / needed;
    climbDistNm *= scale;
    descentDistNm *= scale;
    topAltitudeFt =
      startElevFt + (climbDistNm / p.climbTasKt) * 60 * p.climbRateFpm;
  }
  return { climbDistNm, descentDistNm, topAltitudeFt, totalDistNm };
}

/** TAS (= zero-wind groundspeed) at a distance offset within a hop. */
function speedAt(profile: HopProfile, distNm: number, opts: RouteOptions): number {
  const p = opts.performance;
  if (distNm < profile.climbDistNm) return p.climbTasKt;
  if (distNm >= profile.totalDistNm - profile.descentDistNm) {
    return p.descentTasKt;
  }
  return p.cruiseTasKt;
}

function phaseAt(profile: HopProfile, distNm: number): FlightPhase {
  if (distNm < profile.climbDistNm) return "climb";
  if (distNm >= profile.totalDistNm - profile.descentDistNm) return "descent";
  return "cruise";
}

/** Altitude at a distance offset within a hop (linear within each phase). */
function altitudeAt(
  profile: HopProfile,
  distNm: number,
  startElevFt: number,
  endElevFt: number,
): number {
  if (distNm < profile.climbDistNm) {
    const f = profile.climbDistNm === 0 ? 1 : distNm / profile.climbDistNm;
    return startElevFt + f * (profile.topAltitudeFt - startElevFt);
  }
  const descentStart = profile.totalDistNm - profile.descentDistNm;
  if (distNm >= descentStart) {
    const f =
      profile.descentDistNm === 0
        ? 1
        : (distNm - descentStart) / profile.descentDistNm;
    return profile.topAltitudeFt - f * (profile.topAltitudeFt - endElevFt);
  }
  return profile.topAltitudeFt;
}

// Minutes to traverse [fromNm, toNm) within a hop, integrating across phase
// boundaries exactly (piecewise-constant speed, so this is closed-form).
function minutesOver(
  profile: HopProfile,
  fromNm: number,
  toNm: number,
  opts: RouteOptions,
): number {
  const boundaries = [
    fromNm,
    Math.min(Math.max(profile.climbDistNm, fromNm), toNm),
    Math.min(
      Math.max(profile.totalDistNm - profile.descentDistNm, fromNm),
      toNm,
    ),
    toNm,
  ].sort((a, b) => a - b);
  let minutes = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    if (b <= a) continue;
    const mid = (a + b) / 2;
    minutes += ((b - a) / speedAt(profile, mid, opts)) * 60;
  }
  return minutes;
}

// ---------------------------------------------------------------------------
// Geometry: split each leg (waypoint pair) into segments of at most
// opts.segmentMaxNm, boundaries always at waypoints (PLAN.md §8.3).
// ---------------------------------------------------------------------------
interface RawSegment {
  startIdent: string;
  endIdent: string;
  start: LatLon;
  end: LatLon;
  points: [number, number][];
  distanceNm: number;
  hopIndex: number;
}

function densify(a: LatLon, b: LatLon, distNm: number): [number, number][] {
  const steps = Math.max(1, Math.ceil(distNm / DENSIFY_NM));
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = intermediatePoint(a, b, i / steps);
    pts.push([p.lon, p.lat]);
  }
  return pts;
}

function buildRawSegments(
  waypoints: RouteWaypoint[],
  segmentMaxNm: number,
): RawSegment[] {
  const out: RawSegment[] = [];
  let hopIndex = 0;
  for (let w = 0; w < waypoints.length - 1; w++) {
    const from = waypoints[w]!;
    const to = waypoints[w + 1]!;
    const legDist = greatCircleNm(from, to);
    const pieces = Math.max(1, Math.ceil(legDist / segmentMaxNm));
    let prev: LatLon = from;
    let prevIdent = from.ident;
    for (let i = 1; i <= pieces; i++) {
      const next =
        i === pieces ? to : intermediatePoint(from, to, i / pieces);
      const dist = greatCircleNm(prev, next);
      const cumOnLeg = Math.round((legDist * i) / pieces);
      const endIdent = i === pieces ? to.ident : `${from.ident}+${cumOnLeg}NM`;
      out.push({
        startIdent: prevIdent,
        endIdent,
        start: prev,
        end: next,
        points: densify(prev, next, dist),
        distanceNm: dist,
        hopIndex,
      });
      prev = next;
      prevIdent = endIdent;
    }
    if (to.isFuelStop && w + 1 < waypoints.length - 1) hopIndex++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full route build: geometry + phase profile + UTC/local/daylight times.
// Deterministic and pure — same inputs always produce the same model.
// ---------------------------------------------------------------------------
export function buildRoute(
  waypoints: RouteWaypoint[],
  opts: RouteOptions,
): RouteModel {
  if (waypoints.length < 2) {
    throw new Error("a route needs at least two waypoints");
  }

  const raw = buildRawSegments(waypoints, opts.segmentMaxNm);

  // Hop boundaries: elevation at each hop's start/end for climb/descent.
  const hopCount = raw[raw.length - 1]!.hopIndex + 1;
  const hopDist: number[] = Array(hopCount).fill(0);
  for (const s of raw) hopDist[s.hopIndex] = (hopDist[s.hopIndex] ?? 0) + s.distanceNm;

  const hopEndpoints: { startElev: number; endElev: number }[] = [];
  {
    const stops = waypoints.filter(
      (w, i) =>
        i === 0 ||
        i === waypoints.length - 1 ||
        (w.isFuelStop && i < waypoints.length - 1),
    );
    for (let h = 0; h < hopCount; h++) {
      hopEndpoints.push({
        startElev: stops[h]?.elevationFt ?? 0,
        endElev: stops[h + 1]?.elevationFt ?? 0,
      });
    }
  }
  const profiles = hopEndpoints.map((e, h) =>
    hopProfile(hopDist[h]!, e.startElev, e.endElev, opts),
  );

  const segments: RouteSegment[] = [];
  const groundStops: GroundStop[] = [];
  let clockMs = new Date(opts.departureTimeUtc).getTime();
  let cumulativeNm = 0;
  let hopOffsetNm = 0;
  let currentHop = 0;
  let airborneMinutes = 0;
  let groundMinutes = 0;

  const stopsByIdent = new Map(
    waypoints
      .filter((w, i) => w.isFuelStop && i > 0 && i < waypoints.length - 1)
      .map((w) => [w.ident, w]),
  );

  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]!;
    if (s.hopIndex !== currentHop) {
      currentHop = s.hopIndex;
      hopOffsetNm = 0;
    }
    const profile = profiles[s.hopIndex]!;
    const from = hopOffsetNm;
    const to = hopOffsetNm + s.distanceNm;
    const minutes = minutesOver(profile, from, to, opts);
    const entry = new Date(clockMs);
    const exit = new Date(clockMs + minutes * 60_000);

    const phaseIn = phaseAt(profile, from);
    const phaseOut = phaseAt(profile, Math.max(from, to - 0.001));
    const phase: FlightPhase = phaseIn === phaseOut ? phaseIn : "mixed";
    const midAlt = altitudeAt(
      profile,
      (from + to) / 2,
      hopEndpoints[s.hopIndex]!.startElev,
      hopEndpoints[s.hopIndex]!.endElev,
    );

    const entryTz = zoneFor(s.start.lat, s.start.lon);
    const exitTz = zoneFor(s.end.lat, s.end.lon);
    const time: SegmentTime = {
      entryUtc: entry.toISOString(),
      exitUtc: exit.toISOString(),
      entryLocal: formatLocal(entry.toISOString(), entryTz),
      exitLocal: formatLocal(exit.toISOString(), exitTz),
      entryTz,
      exitTz,
      entryDaylight: daylightAt(entry, s.start.lat, s.start.lon),
      exitDaylight: daylightAt(exit, s.end.lat, s.end.lon),
    };

    cumulativeNm += s.distanceNm;
    segments.push({
      seq: i,
      startIdent: s.startIdent,
      endIdent: s.endIdent,
      startLat: s.start.lat,
      startLon: s.start.lon,
      endLat: s.end.lat,
      endLon: s.end.lon,
      points: s.points,
      distanceNm: s.distanceNm,
      cumulativeDistanceNm: cumulativeNm,
      altitudeFt: Math.round(midAlt),
      phase,
      groundspeedKt: minutes > 0 ? (s.distanceNm / minutes) * 60 : 0,
      time,
    });

    airborneMinutes += minutes;
    clockMs = exit.getTime();
    hopOffsetNm = to;

    // Ground stop at this segment's end?
    const stop = stopsByIdent.get(s.endIdent);
    const isLastOfHop = i + 1 < raw.length && raw[i + 1]!.hopIndex !== s.hopIndex;
    if (stop && isLastOfHop) {
      const departMs = clockMs + stop.groundMinutes * 60_000;
      groundStops.push({
        ident: stop.ident,
        arriveUtc: new Date(clockMs).toISOString(),
        departUtc: new Date(departMs).toISOString(),
        groundMinutes: stop.groundMinutes,
      });
      groundMinutes += stop.groundMinutes;
      clockMs = departMs;
    }
  }

  const last = segments[segments.length - 1]!;
  return {
    waypoints: waypoints.map((w) => ({
      ident: w.ident,
      lat: w.lat,
      lon: w.lon,
    })),
    segments,
    groundStops,
    totals: {
      distanceNm: cumulativeNm,
      airborneMinutes,
      groundMinutes,
      departureUtc: new Date(opts.departureTimeUtc).toISOString(),
      arrivalUtc: last.time.exitUtc,
      arrivalLocal: last.time.exitLocal,
      arrivalTz: last.time.exitTz,
      arrivalDaylight: last.time.exitDaylight,
    },
    engine: { version: ENGINE_VERSION, wind: "zero-wind" },
  };
}
