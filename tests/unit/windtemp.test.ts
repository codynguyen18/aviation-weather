import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { decodeGroup, parseWindTemp } from "@/lib/wx/windtemp";

const fixture = readFileSync(
  path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", "awc-windtemp-chi-low-06.txt"),
  "utf8",
);

// Reference date matching the captured bulletin (July 2026).
const REF = new Date("2026-07-18T04:00:00Z");

describe("decodeGroup", () => {
  it("4-char group: 2722 -> 270deg 22kt, no temp", () => {
    expect(decodeGroup("2722", 3000)).toEqual({
      windDirDeg: 270, windSpeedKt: 22, tempC: null, lightVariable: false,
    });
  });

  it("7-char group with sign: 2711+17", () => {
    expect(decodeGroup("2711+17", 6000)).toEqual({
      windDirDeg: 270, windSpeedKt: 11, tempC: 17, lightVariable: false,
    });
  });

  it("6-char high-altitude group: temps implied negative (321231 @30000)", () => {
    expect(decodeGroup("321231", 30000)).toEqual({
      windDirDeg: 320, windSpeedKt: 12, tempC: -31, lightVariable: false,
    });
  });

  it("9900 = light and variable", () => {
    expect(decodeGroup("9900-15", 24000)).toEqual({
      windDirDeg: null, windSpeedKt: 0, tempC: -15, lightVariable: true,
    });
  });

  it("coded dir > 36: 7545 -> 250 deg at 145 kt (dir-50, speed+100)", () => {
    expect(decodeGroup("754537", 39000)).toEqual({
      windDirDeg: 250, windSpeedKt: 145, tempC: -37, lightVariable: false,
    });
  });

  it("blank cell decodes to null (high-elevation station gap)", () => {
    expect(decodeGroup("   ", 3000)).toBeNull();
  });
});

describe("parseWindTemp on the captured live bulletin", () => {
  const b = parseWindTemp(fixture, REF)!;

  it("parses header times: based 180000Z, valid 180600Z, for use 0200-0900Z", () => {
    expect(b.basedOn).toBe("2026-07-18T00:00:00.000Z");
    expect(b.validAt).toBe("2026-07-18T06:00:00.000Z");
    expect(b.forUseFrom).toBe("2026-07-18T02:00:00.000Z");
    expect(b.forUseTo).toBe("2026-07-18T09:00:00.000Z");
  });

  it("BRL decodes across all nine levels", () => {
    const brl = b.entries.filter((e) => e.station === "BRL");
    expect(brl.length).toBe(9);
    expect(brl.find((e) => e.levelFt === 3000)).toMatchObject({
      windDirDeg: 270, windSpeedKt: 22, tempC: null,
    });
    expect(brl.find((e) => e.levelFt === 39000)).toMatchObject({
      windDirDeg: 280, windSpeedKt: 15, tempC: -53,
    });
  });

  it("GCK (high elevation) has no 3000 ft entry but has upper levels", () => {
    const gck = b.entries.filter((e) => e.station === "GCK");
    expect(gck.find((e) => e.levelFt === 3000)).toBeUndefined();
    expect(gck.find((e) => e.levelFt === 24000)).toMatchObject({
      lightVariable: true, windSpeedKt: 0,
    });
  });

  it("an overnight FOR USE window (1800-0600Z) spans midnight correctly", () => {
    const overnight = fixture
      .replace("VALID 180600Z   FOR USE 0200-0900Z", "VALID 190000Z   FOR USE 1800-0600Z");
    const p = parseWindTemp(overnight, REF)!;
    expect(p.forUseFrom).toBe("2026-07-18T18:00:00.000Z");
    expect(p.forUseTo).toBe("2026-07-19T06:00:00.000Z");
  });
});
