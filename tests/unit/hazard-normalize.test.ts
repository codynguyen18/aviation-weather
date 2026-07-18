import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  gairmetLevelToFt,
  normalizeAirsigmet,
  normalizeCwa,
  normalizeGairmet,
  rawValidUntil,
} from "@/lib/wx/normalize-hazard";

const fc = (name: string) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", name),
      "utf8",
    ),
  ) as { features: never[] };

describe("normalizeAirsigmet (captured convective SIGMETs)", () => {
  const features = fc("awc-airsigmet-geojson.geojson").features;

  it("normalizes every captured feature with polygon geometry", () => {
    const rows = features.map(normalizeAirsigmet).filter((r) => r !== null);
    expect(rows.length).toBe(features.length);
    for (const r of rows) {
      expect(["CONVECTIVE", "TURB", "ICE", "IFR", "MTN_OBSC", "OTHER"]).toContain(r.hazard);
      expect(Date.parse(r.validTo)).toBeGreaterThan(Date.parse(r.validFrom));
    }
  });

  it("convective SIGMET floor defaults to the surface; tops from altitudeHi", () => {
    const conv = features.map(normalizeAirsigmet).find((r) => r?.hazard === "CONVECTIVE")!;
    expect(conv.floorFtMsl).toBe(0);
    expect(conv.ceilingFtMsl).toBeGreaterThan(20000);
  });

  it("truncated API validity is extended by the raw text (conservative)", () => {
    const f = structuredClone(features[0]) as unknown as {
      properties: Record<string, unknown>;
    };
    // Simulate the live-observed truncation: API says 03:54:59, raw says 0555Z.
    f.properties.validTimeFrom = "2026-07-18T02:55:00.000Z";
    f.properties.validTimeTo = "2026-07-18T03:54:59.000Z";
    f.properties.rawAirSigmet = "WSUS32 KKCI 180255\nSIGC\nCONVECTIVE SIGMET 23C\nVALID UNTIL 0555Z\n...";
    const n = normalizeAirsigmet(f as never)!;
    expect(n.validTo).toBe("2026-07-18T05:55:00.000Z");
  });

  it("rawValidUntil rolls past midnight", () => {
    expect(rawValidUntil("VALID UNTIL 0155Z", "2026-07-18T23:55:00.000Z")).toBe(
      "2026-07-19T01:55:00.000Z",
    );
  });
});

describe("normalizeGairmet (captured G-AIRMETs)", () => {
  const features = fc("awc-gairmet-geojson.geojson").features;

  it("altitude strings decode as hundreds of feet; SFC = 0", () => {
    expect(gairmetLevelToFt("090")).toBe(9000);
    expect(gairmetLevelToFt("390")).toBe(39000);
    expect(gairmetLevelToFt("SFC")).toBe(0);
    expect(gairmetLevelToFt(null)).toBeNull();
  });

  it("snapshots get a ±90 min validity window around validTime", () => {
    const n = features.map(normalizeGairmet).find((r) => r !== null)!;
    const span = Date.parse(n.validTo) - Date.parse(n.validFrom);
    expect(span).toBe(3 * 60 * 60_000);
  });

  it("hazard vocabulary maps (TURB-LO -> TURB, MT_OBSC kept)", () => {
    const all = features.map(normalizeGairmet).filter((r) => r !== null);
    const kinds = new Set(all.map((r) => r.hazard));
    for (const k of kinds) {
      expect(["TURB", "ICE", "IFR", "MTN_OBSC", "LLWS", "SFC_WIND", "FZLVL", "OTHER"]).toContain(k);
    }
  });
});

describe("normalizeCwa", () => {
  it("parses a synthetic CWA feature (real capture had none active — itself valid)", () => {
    const n = normalizeCwa({
      geometry: { type: "Polygon", coordinates: [[[-97, 32], [-96, 32], [-96, 33], [-97, 33], [-97, 32]]] },
      properties: {
        cwsu: "ZFW", name: "Fort Worth", seriesId: "101", hazard: "TS",
        qualifier: "ISOL TSRA MOD TO HVY PCPN", top: 40000, base: null,
        validTimeFrom: "2026-07-17T19:06:00Z", validTimeTo: "2026-07-17T21:06:00Z",
        cwaText: "FAUS21 KZFW 171906...",
      },
    })!;
    expect(n.hazard).toBe("CONVECTIVE");
    expect(n.ceilingFtMsl).toBe(40000);
    expect(n.floorFtMsl).toBeNull();
    expect(n.externalKey).toContain("ZFW");
  });
});
