import { describe, expect, it } from "vitest";

import { evaluateSegment, summarizeTrip } from "@/lib/rules/aggregate";
import {
  aircraftLimitsSchema,
  pilotMinimumsSchema,
  type SegmentContext,
  type StationObservation,
  type ForecastGroup,
  type NearbyPirep,
} from "@/lib/rules/types";
import type { RouteSegment } from "@/lib/route/types";
import type { HazardHit } from "@/lib/wx/intersect";

// Synthetic-context tests for the rule catalog: the "difficult set" from
// PLAN.md §18.5. Every scenario is a pilot-meaningful situation.

const MINIMUMS = pilotMinimumsSchema.parse({});     // IFR 800/2, 25kt, no night
const AIRCRAFT = aircraftLimitsSchema.parse({});    // 300 min endurance

function segment(overrides: Partial<RouteSegment> = {}): RouteSegment {
  return {
    seq: 5,
    startIdent: "A", endIdent: "B",
    startLat: 39, startLon: -95, endLat: 39, endLon: -96,
    points: [[-95, 39], [-96, 39]],
    distanceNm: 47, cumulativeDistanceNm: 250, altitudeFt: 10500,
    phase: "cruise", groundspeedKt: 160,
    headwindKt: 5, windDirDeg: 270, windSpeedKt: 20, windStation: "STL",
    windSourceRecordId: "wind-src-1", windSource: "fb",
    time: {
      entryUtc: "2026-07-18T15:00:00.000Z", exitUtc: "2026-07-18T15:18:00.000Z",
      entryLocal: "2026-07-18 10:00 CDT", exitLocal: "2026-07-18 10:18 CDT",
      entryTz: "America/Chicago", exitTz: "America/Chicago",
      entryDaylight: "day", exitDaylight: "day",
      fuelUsedMinAtExit: 90, fuelAheadMin: 60,
    },
    ...overrides,
  };
}

function ctx(overrides: Partial<SegmentContext> = {}): SegmentContext {
  return {
    segment: segment(),
    isFirst: false, isLast: false,
    terminalAirports: [], runways: [],
    minimums: MINIMUMS, aircraft: AIRCRAFT,
    hazards: [], observations: [], forecastGroups: [], pireps: [],
    hazardFeedsOk: true, metarFeedOk: true, tafFeedOk: true, pirepFeedOk: true,
    dutyStartUtc: null, departureTimeUtc: "2026-07-18T13:00:00.000Z",
    remainingFlightMinAfterSegment: 200, totalAirborneMin: 560,
    ...overrides,
  };
}

const obs = (o: Partial<StationObservation>): StationObservation => ({
  station: "KTST", observedAt: "2026-07-18T14:54:00.000Z",
  flightCategory: "VFR", visibilitySm: 10, ceilingFtAgl: null,
  windDirDeg: 270, windSpeedKt: 10, windGustKt: null, distanceNm: 3,
  freshness: "fresh", sourceRecordId: "src-obs-1", rawText: "METAR KTST ...",
  ...o,
});

const fcst = (f: Partial<ForecastGroup>): ForecastGroup => ({
  station: "KTST", issuedAt: "2026-07-18T12:00:00.000Z", groupType: "FM",
  probability: null, validFrom: "2026-07-18T14:00:00.000Z",
  validTo: "2026-07-18T18:00:00.000Z", visibilitySm: 6, ceilingFtAgl: 4000,
  windDirDeg: 270, windSpeedKt: 12, windGustKt: null, wxString: null,
  freshness: "fresh", sourceRecordId: "src-taf-1", rawText: "TAF KTST ...",
  ...f,
});

const convHit = (h: Partial<HazardHit> = {}): HazardHit => ({
  hazardId: "hz1", sourceRecordId: "src-hz-1", product: "AIRSIGMET",
  hazard: "CONVECTIVE", severity: "5", qualifier: "SIGMET",
  floorFtMsl: 0, ceilingFtMsl: 42000,
  validFrom: "2026-07-18T14:55:00.000Z", validTo: "2026-07-18T16:55:00.000Z",
  clipNm: 22, clipGeojson: null, rawText: "CONVECTIVE SIGMET 23C ...",
  ...h,
});

describe("hard limits", () => {
  it("TAF ceiling below personal minimum -> red hard stop", () => {
    const a = evaluateSegment(ctx({
      terminalAirports: ["KTST"],
      forecastGroups: [fcst({ ceilingFtAgl: 500 })],
    }));
    expect(a.rating).toBe("red");
    const rule = a.evaluations.find((e) => e.ruleId === "ceiling-below-minimum")!;
    expect(rule.result).toBe("red");
    expect(rule.isHardStop).toBe(true);
    expect(rule.explanation).toContain("below your 800 ft minimum");
    expect(rule.sourceRecordIds).toContain("src-taf-1");
  });

  it("missing TAF+METAR at a terminal segment -> UNKNOWN, never green", () => {
    const a = evaluateSegment(ctx({ terminalAirports: ["KDST"] }));
    expect(a.rating).toBe("unknown");
    expect(a.summary).toMatch(/cannot verify|No current ceiling/i);
  });

  it("only STALE observations at a terminal -> unknown (stale can't support green)", () => {
    const a = evaluateSegment(ctx({
      terminalAirports: ["KTST"],
      observations: [obs({ freshness: "stale", ceilingFtAgl: 5000 })],
    }));
    expect(a.rating).toBe("unknown");
  });

  it("en-route segment without stations is not penalized by terminal rules", () => {
    const a = evaluateSegment(ctx({}));
    expect(a.evaluations.find((e) => e.ruleId === "ceiling-below-minimum")).toBeUndefined();
    expect(a.rating).toBe("green"); // hazard feeds healthy, nothing intersects
  });

  it("gusts count against the surface wind limit", () => {
    const a = evaluateSegment(ctx({
      terminalAirports: ["KTST"],
      observations: [obs({ windSpeedKt: 18, windGustKt: 31 })],
      forecastGroups: [fcst({})],
    }));
    const rule = a.evaluations.find((e) => e.ruleId === "surface-wind-limit")!;
    expect(rule.result).toBe("red");
    expect(rule.measured.windOrGustKt).toBe(31);
  });

  it("crosswind: 90-degree 20 kt wind exceeds a 15 kt limit -> red", () => {
    const a = evaluateSegment(ctx({
      terminalAirports: ["KTST"],
      runways: [{ airportIdent: "KTST", headingDeg: 360, ident: "36" }],
      observations: [obs({ windDirDeg: 90, windSpeedKt: 20 })],
      forecastGroups: [fcst({})],
    }));
    const rule = a.evaluations.find((e) => e.ruleId === "crosswind-limit")!;
    expect(rule.result).toBe("red");
    expect(Number(rule.measured.crosswindKt)).toBe(20);
  });

  it("winds aloft over the pilot's limit -> red; unavailable -> unknown (not zero)", () => {
    const over = evaluateSegment(ctx({
      segment: segment({ windSpeedKt: 55 }),
    }));
    expect(over.evaluations.find((e) => e.ruleId === "winds-aloft-limit")!.result).toBe("red");

    const none = evaluateSegment(ctx({
      segment: segment({ windSource: "none", windSpeedKt: null }),
    }));
    const e = none.evaluations.find((x) => x.ruleId === "winds-aloft-limit")!;
    expect(e.result).toBe("unknown");
    expect(none.rating).not.toBe("red"); // soft unknown degrades confidence only
    expect(none.confidence).toBe("low");
  });

  it("night segment with night flying disallowed -> red", () => {
    const a = evaluateSegment(ctx({
      segment: segment({
        time: { ...segment().time, exitDaylight: "night" },
      }),
    }));
    expect(a.rating).toBe("red");
    expect(a.hardStops[0]).toMatch(/darkness/);
  });

  it("fuel: deviation that erodes the reserve -> red", () => {
    // 300 min endurance; 200 used + 80 ahead + 60 reserve = 340 > 300.
    const a = evaluateSegment(ctx({
      segment: segment({
        time: { ...segment().time, fuelUsedMinAtExit: 200, fuelAheadMin: 80 },
      }),
    }));
    const rule = a.evaluations.find((e) => e.ruleId === "fuel-reserve")!;
    expect(rule.result).toBe("red");
  });

  it("duty time past the limit -> red with assumption labeled", () => {
    const a = evaluateSegment(ctx({
      minimums: { ...MINIMUMS, maxDutyMin: 90 },
      // departure 13:00Z, assumed duty start 12:00Z, segment exit 15:18Z = 198 min
    }));
    const rule = a.evaluations.find((e) => e.ruleId === "duty-time-limit")!;
    expect(rule.result).toBe("red");
    expect(rule.explanation).toContain("assumed");
  });
});

describe("advisories and convection", () => {
  it("active convective SIGMET intersecting at ETA -> red hard stop with clip", () => {
    const a = evaluateSegment(ctx({ hazards: [convHit()] }));
    expect(a.rating).toBe("red");
    const rule = a.evaluations.find((e) => e.ruleId === "convective-sigmet-intersect")!;
    expect(rule.isHardStop).toBe(true);
    expect(rule.explanation).toContain("crossing 22 nm");
  });

  it("hazard feed down -> segment UNKNOWN (convective status unverifiable)", () => {
    const a = evaluateSegment(ctx({ hazardFeedsOk: false }));
    expect(a.rating).toBe("unknown");
    expect(a.summary).toContain("Convective SIGMET feed unavailable");
  });

  it("moderate-turbulence PIREP -> yellow; severe -> red", () => {
    const mod: NearbyPirep = {
      observedAt: "2026-07-18T14:40:00.000Z", distanceNm: 14,
      altitudeFtMsl: 9500, aircraftType: "C182", urgent: false,
      turbulence: [{ intensity: "MOD" }], icing: [], ageMin: 42,
      sourceRecordId: "src-p1", rawText: "UA /OV ...",
    };
    const yellow = evaluateSegment(ctx({ pireps: [mod] }));
    expect(yellow.rating).toBe("yellow");

    const sev = evaluateSegment(ctx({
      pireps: [{ ...mod, turbulence: [{ intensity: "SEV" }] }],
    }));
    expect(sev.rating).toBe("red");
  });

  it("G-AIRMET icing at altitude -> yellow with pilot-readable label", () => {
    const a = evaluateSegment(ctx({
      hazards: [convHit({ product: "GAIRMET", hazard: "ICE", clipNm: 30 })],
    }));
    expect(a.rating).toBe("yellow");
    expect(a.summary).toContain("moderate icing");
  });

  it("TS in the destination TAF window -> yellow decision-gate language", () => {
    const a = evaluateSegment(ctx({
      terminalAirports: ["KTST"],
      forecastGroups: [
        fcst({}),
        fcst({ groupType: "TEMPO", wxString: "TSRA", ceilingFtAgl: 3000 }),
      ],
    }));
    expect(a.rating).toBe("yellow");
    expect(a.summary).toContain("decision gate");
  });

  it("observation two categories worse than forecast -> sources-disagree yellow", () => {
    const a = evaluateSegment(ctx({
      observations: [obs({ flightCategory: "IFR", ceilingFtAgl: 900, visibilitySm: 2.5 })],
      forecastGroups: [fcst({ station: "KTST", ceilingFtAgl: 5000, visibilitySm: 6 })],
      minimums: { ...MINIMUMS, minCeilingFt: 500, minVisibilitySm: 1 },
    }));
    const rule = a.evaluations.find((e) => e.ruleId === "source-conflict")!;
    expect(rule.result).toBe("yellow");
    expect(rule.explanation).toContain("sources disagree");
  });

  it("twilight arrival with night allowed -> yellow advisory, not red", () => {
    const a = evaluateSegment(ctx({
      isLast: true,
      minimums: { ...MINIMUMS, nightOk: true },
      segment: segment({
        time: { ...segment().time, exitDaylight: "civil-twilight" },
      }),
    }));
    expect(a.rating).toBe("yellow");
    expect(a.summary).toContain("twilight");
  });
});

describe("aggregation honesty", () => {
  it("no data + no hazard feeds -> unknown, never green", () => {
    const a = evaluateSegment(ctx({
      hazardFeedsOk: false, metarFeedOk: false, tafFeedOk: false,
      segment: segment({ windSource: "none", windSpeedKt: null }),
    }));
    expect(a.rating).toBe("unknown");
  });

  it("trip summary counts and worst rating", () => {
    const good = evaluateSegment(ctx({}));
    const bad = evaluateSegment(ctx({ hazards: [convHit()] }));
    const t = summarizeTrip([good, bad]);
    expect(t.worstRating).toBe("red");
    expect(t.counts.green).toBe(1);
    expect(t.counts.red).toBe(1);
    expect(t.hardStops.length).toBeGreaterThan(0);
  });
});
