import { describe, expect, it } from "vitest";

import { greatCircleNm, initialBearingDeg } from "@/lib/geo";

// Airport reference points (FAA published coordinates).
const KSTL = { lat: 38.748697, lon: -90.370028 };
const KOAK = { lat: 37.721278, lon: -122.220722 };
const KJFK = { lat: 40.639722, lon: -73.778889 };
const KLAX = { lat: 33.9425, lon: -118.408056 };

describe("greatCircleNm", () => {
  it("KSTL -> KOAK is ~1496 nm", () => {
    const d = greatCircleNm(KSTL, KOAK);
    expect(d).toBeGreaterThan(1488);
    expect(d).toBeLessThan(1504);
  });

  it("KJFK -> KLAX matches the well-known ~2144 nm figure", () => {
    const d = greatCircleNm(KJFK, KLAX);
    expect(d).toBeGreaterThan(2133);
    expect(d).toBeLessThan(2155);
  });

  it("is symmetric and zero on identical points", () => {
    expect(greatCircleNm(KSTL, KOAK)).toBeCloseTo(greatCircleNm(KOAK, KSTL), 6);
    expect(greatCircleNm(KSTL, KSTL)).toBe(0);
  });
});

describe("initialBearingDeg", () => {
  it("KSTL -> KOAK departs westbound (roughly 279 true)", () => {
    const brg = initialBearingDeg(KSTL, KOAK);
    expect(brg).toBeGreaterThan(270);
    expect(brg).toBeLessThan(290);
  });

  it("due north is 0", () => {
    expect(
      initialBearingDeg({ lat: 38, lon: -90 }, { lat: 39, lon: -90 }),
    ).toBeCloseTo(0, 6);
  });
});
