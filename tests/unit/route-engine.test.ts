import { describe, expect, it } from "vitest";

import { buildRoute } from "@/lib/route/engine";
import type { RouteOptions, RouteWaypoint } from "@/lib/route/types";

// Published airport reference points + elevations.
const KSTL: RouteWaypoint = {
  kind: "airport", ident: "KSTL", name: "St. Louis Lambert Intl",
  lat: 38.748697, lon: -90.370028, elevationFt: 618, type: "large_airport",
  isoCountry: "US", municipality: "St Louis", navSource: "test",
  isFuelStop: false, groundMinutes: 45,
};
const KRNO: RouteWaypoint = {
  kind: "airport", ident: "KRNO", name: "Reno Tahoe Intl",
  lat: 39.499199, lon: -119.767903, elevationFt: 4415, type: "large_airport",
  isoCountry: "US", municipality: "Reno", navSource: "test",
  isFuelStop: false, groundMinutes: 45,
};
const KOAK: RouteWaypoint = {
  kind: "airport", ident: "KOAK", name: "Oakland Intl",
  lat: 37.721278, lon: -122.220722, elevationFt: 13, type: "large_airport",
  isoCountry: "US", municipality: "Oakland", navSource: "test",
  isFuelStop: false, groundMinutes: 45,
};

// Bonanza-ish profile from the plan (§8.5).
const OPTS: RouteOptions = {
  departureTimeUtc: "2026-07-18T13:00:00Z",
  cruiseAltitudeFt: 10500,
  performance: {
    cruiseTasKt: 165, climbRateFpm: 900, climbTasKt: 130,
    descentRateFpm: 500, descentTasKt: 140,
  },
  segmentMaxNm: 50,
  corridorWidthNm: 25,
};

describe("buildRoute KSTL->KOAK direct (hand-computed cross-check)", () => {
  const model = buildRoute([KSTL, KOAK], OPTS);

  it("total distance matches the great-circle figure (~1496 nm spherical)", () => {
    expect(model.totals.distanceNm).toBeGreaterThan(1488);
    expect(model.totals.distanceNm).toBeLessThan(1504);
  });

  it("segment count and max length respect the 50 nm setting", () => {
    expect(model.segments.length).toBe(Math.ceil(model.totals.distanceNm / 50));
    for (const s of model.segments) {
      expect(s.distanceNm).toBeLessThanOrEqual(50.01);
    }
  });

  it("segment distances sum to the total", () => {
    const sum = model.segments.reduce((a, s) => a + s.distanceNm, 0);
    expect(sum).toBeCloseTo(model.totals.distanceNm, 6);
  });

  it("airborne time matches hand-computed climb/cruise/descent", () => {
    // Hand computation:
    // climb  (10500-618)  ft @900 fpm = 10.98 min @130 kt -> 23.79 nm
    // descent(10500-13)   ft @500 fpm = 20.97 min @140 kt -> 48.94 nm
    // cruise = total - 23.79 - 48.94 @165 kt
    const d = model.totals.distanceNm;
    const climbMin = (10500 - 618) / 900;
    const descentMin = (10500 - 13) / 500;
    const climbNm = (climbMin / 60) * 130;
    const descentNm = (descentMin / 60) * 140;
    const cruiseMin = ((d - climbNm - descentNm) / 165) * 60;
    const expected = climbMin + descentMin + cruiseMin;
    expect(model.totals.airborneMinutes).toBeCloseTo(expected, 1);
  });

  it("phases appear in order: climb, cruise..., descent/mixed at the end", () => {
    expect(["climb", "mixed"]).toContain(model.segments[0]!.phase);
    const midway = model.segments[Math.floor(model.segments.length / 2)]!;
    expect(midway.phase).toBe("cruise");
    expect(midway.altitudeFt).toBe(10500);
    expect(midway.groundspeedKt).toBeCloseTo(165, 0);
    const last = model.segments[model.segments.length - 1]!;
    expect(["descent", "mixed"]).toContain(last.phase);
  });

  it("crosses Central -> Pacific time and formats both", () => {
    expect(model.segments[0]!.time.entryTz).toBe("America/Chicago");
    expect(model.totals.arrivalTz).toBe("America/Los_Angeles");
    expect(model.segments[0]!.time.entryLocal).toMatch(/CDT$/);
    expect(model.totals.arrivalLocal).toMatch(/PDT$/);
    // Mountain time appears somewhere en route (western Nebraska/Wyoming...).
    const zones = new Set(model.segments.map((s) => s.time.entryTz));
    expect(zones.has("America/Denver")).toBe(true);
  });

  it("a 13:00Z summer departure arrives in daylight (~9h flight)", () => {
    expect(model.segments[0]!.time.entryDaylight).toBe("day");
    expect(model.totals.arrivalDaylight).toBe("day");
  });
});

describe("fuel stops", () => {
  const stop: RouteWaypoint = { ...KRNO, isFuelStop: true, groundMinutes: 45 };
  const model = buildRoute([KSTL, stop, KOAK], OPTS);
  const direct = buildRoute([KSTL, KOAK], OPTS);

  it("adds ground time and a second climb/descent cycle", () => {
    expect(model.groundStops).toHaveLength(1);
    expect(model.groundStops[0]!.ident).toBe("KRNO");
    expect(model.totals.groundMinutes).toBe(45);
    // Via-Reno is longer than direct, plus the extra climb/descent is slower
    // than cruising the same distance.
    expect(model.totals.distanceNm).toBeGreaterThan(direct.totals.distanceNm);
    expect(model.totals.airborneMinutes).toBeGreaterThan(
      direct.totals.airborneMinutes,
    );
  });

  it("arrival = departure + airborne + ground, within a second", () => {
    const dep = new Date(model.totals.departureUtc).getTime();
    const arr = new Date(model.totals.arrivalUtc).getTime();
    const expectedMin =
      model.totals.airborneMinutes + model.totals.groundMinutes;
    expect(Math.abs((arr - dep) / 60000 - expectedMin)).toBeLessThan(1 / 60);
  });

  it("descends to Reno's 4,415 ft elevation, not to sea level", () => {
    const intoReno = model.segments.filter(
      (s) => s.endIdent === "KRNO",
    ).pop()!;
    expect(["descent", "mixed"]).toContain(intoReno.phase);
    // Altitude just before the stop should be between field elev and cruise.
    expect(intoReno.altitudeFt).toBeGreaterThan(4415);
    expect(intoReno.altitudeFt).toBeLessThan(10500);
  });
});

describe("short-hop profile (cannot reach cruise)", () => {
  it("KSTL->KCPS (12 nm) scales climb/descent instead of teleporting", () => {
    const KCPS: RouteWaypoint = {
      ...KOAK, ident: "KCPS", name: "St Louis Downtown",
      lat: 38.5707, lon: -90.1562, elevationFt: 413,
    };
    const model = buildRoute([KSTL, KCPS], {
      ...OPTS, cruiseAltitudeFt: 10500,
    });
    expect(model.totals.distanceNm).toBeGreaterThan(10);
    expect(model.totals.distanceNm).toBeLessThan(20);
    // Never reports reaching cruise altitude on a 12 nm hop.
    for (const s of model.segments) {
      expect(s.altitudeFt).toBeLessThan(10500);
    }
    // Time is finite and sane (single segment, mixed phase).
    expect(model.totals.airborneMinutes).toBeGreaterThan(3);
    expect(model.totals.airborneMinutes).toBeLessThan(15);
  });
});

describe("daylight-saving spring-forward (2026-03-08, US)", () => {
  it("a 2h flight spans a 3h local wall-clock jump", () => {
    // 07:30Z = 01:30 CST; 2h later 09:30Z = 04:30 CDT (02:00-03:00 never exists)
    const A: RouteWaypoint = { ...KSTL, ident: "A" };
    const B: RouteWaypoint = {
      ...KSTL, ident: "B", lat: 41.5, lon: -93.66, // Des Moines-ish, same zone
    };
    const model = buildRoute([A, B], {
      ...OPTS,
      departureTimeUtc: "2026-03-08T07:30:00Z",
      performance: { ...OPTS.performance, cruiseTasKt: 120 },
    });
    expect(model.segments[0]!.time.entryLocal).toMatch(/01:30 CST$/);
    const arrMin =
      (new Date(model.totals.arrivalUtc).getTime() -
        new Date(model.totals.departureUtc).getTime()) / 60000;
    expect(arrMin).toBeGreaterThan(100); // ~2h flight
    expect(model.totals.arrivalLocal).toMatch(/CDT$/);
    const hour = Number(model.totals.arrivalLocal.split(" ")[1]!.split(":")[0]);
    expect(hour).toBeGreaterThanOrEqual(4); // 01:30 + ~2h flight -> 04:xx CDT
  });
});
