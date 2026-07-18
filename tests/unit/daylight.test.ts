import { describe, expect, it } from "vitest";

import { daylightAt } from "@/lib/route/daylight";

// Oracle: USNO Astronomical Applications API for KSTL (38.7487, -90.37) on
// 2026-07-18, fetched live during planning research:
//   Begin civil twilight 05:20 CDT, sunrise 05:51, sunset 20:24,
//   end civil twilight 20:55 CDT.  (CDT = UTC-5)
const LAT = 38.7487;
const LON = -90.37;

describe("daylightAt vs USNO almanac for KSTL 2026-07-18", () => {
  it("noon local is day", () => {
    expect(daylightAt(new Date("2026-07-18T17:00:00Z"), LAT, LON)).toBe("day");
  });

  it("20:40 local (after sunset, before twilight end) is civil twilight", () => {
    expect(daylightAt(new Date("2026-07-19T01:40:00Z"), LAT, LON)).toBe(
      "civil-twilight",
    );
  });

  it("21:10 local (after civil twilight ends) is night", () => {
    expect(daylightAt(new Date("2026-07-19T02:10:00Z"), LAT, LON)).toBe(
      "night",
    );
  });

  it("05:35 local (dawn twilight) is civil twilight", () => {
    expect(daylightAt(new Date("2026-07-18T10:35:00Z"), LAT, LON)).toBe(
      "civil-twilight",
    );
  });

  it("03:00 local is night", () => {
    expect(daylightAt(new Date("2026-07-18T08:00:00Z"), LAT, LON)).toBe(
      "night",
    );
  });

  it("suncalc's sunset agrees with USNO within 3 minutes", async () => {
    const SunCalc = await import("suncalc");
    const t = SunCalc.getTimes(new Date("2026-07-18T18:00:00Z"), LAT, LON);
    const usnoSunsetUtc = new Date("2026-07-19T01:24:00Z").getTime(); // 20:24 CDT
    expect(Math.abs(t.sunset!.getTime() - usnoSunsetUtc)).toBeLessThan(
      3 * 60_000,
    );
    const usnoDuskUtc = new Date("2026-07-19T01:55:00Z").getTime(); // 20:55 CDT
    expect(Math.abs(t.dusk!.getTime() - usnoDuskUtc)).toBeLessThan(3 * 60_000);
  });
});
