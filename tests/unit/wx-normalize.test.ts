import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ceilingFrom,
  flightCategory,
  normalizeMetar,
  normalizePirep,
  normalizeTaf,
} from "@/lib/wx/normalize";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", name),
      "utf8",
    ),
  );

describe("normalizeMetar (live-captured fixture)", () => {
  const metars = fixture("awc-metar-json.json") as Record<string, unknown>[];
  const krno = normalizeMetar(metars.find((m) => m.icaoId === "KRNO")!)!;

  it("epoch obsTime becomes UTC ISO", () => {
    expect(krno.observedAt).toBe("2026-07-18T03:55:00.000Z");
  });

  it('visibility "10+" becomes 10 with a capped flag, never null', () => {
    expect(krno.visibilitySm).toBe(10);
    expect(krno.missingFields).toContain("visibility_capped");
  });

  it("altimeter converts hPa -> inHg (1017.7 hPa ≈ 30.05)", () => {
    expect(krno.altimInHg).toBeGreaterThan(30.0);
    expect(krno.altimInHg).toBeLessThan(30.1);
  });

  it("FEW 18000 is not a ceiling", () => {
    expect(krno.ceilingFtAgl).toBeNull();
    expect(krno.flightCategory).toBe("VFR");
  });

  it("wind incl. gust parsed", () => {
    expect(krno.windDirDeg).toBe(280);
    expect(krno.windSpeedKt).toBe(16);
    expect(krno.windGustKt).toBe(26);
  });

  it("a METAR missing visibility flags it instead of implying unlimited", () => {
    const n = normalizeMetar({
      icaoId: "KTST", obsTime: 1784350440, rawOb: "METAR KTST ...",
      temp: 20, wdir: 100, wspd: 5, clouds: [],
    })!;
    expect(n.visibilitySm).toBeNull();
    expect(n.missingFields).toContain("visibility");
  });

  it("VRB wind keeps direction null with a flag", () => {
    const n = normalizeMetar({
      icaoId: "KTST", obsTime: 1784350440, rawOb: "x", wdir: "VRB", wspd: 4,
      visib: 10, temp: 20, clouds: [],
    })!;
    expect(n.windDirDeg).toBeNull();
    expect(n.missingFields).toContain("wind_variable");
  });
});

describe("ceiling & flight category ladder", () => {
  it("lowest BKN/OVC/VV wins; SCT/FEW ignored", () => {
    expect(
      ceilingFrom([
        { cover: "SCT", baseFtAgl: 800 },
        { cover: "BKN", baseFtAgl: 2500 },
        { cover: "OVC", baseFtAgl: 4000 },
      ]),
    ).toBe(2500);
    expect(ceilingFrom([{ cover: "FEW", baseFtAgl: 500 }])).toBeNull();
    expect(ceilingFrom([], 300)).toBe(300); // vertical visibility is a ceiling
  });

  it("category boundaries match the US ladder", () => {
    expect(flightCategory(400, 10)).toBe("LIFR");
    expect(flightCategory(900, 10)).toBe("IFR");
    expect(flightCategory(2500, 10)).toBe("MVFR");
    expect(flightCategory(3000, 10)).toBe("MVFR"); // 3000 inclusive
    expect(flightCategory(3500, 5)).toBe("MVFR");  // 5 sm inclusive
    expect(flightCategory(3500, 6)).toBe("VFR");
    expect(flightCategory(null, 0.5)).toBe("LIFR");
    expect(flightCategory(null, null)).toBeNull(); // nothing known -> unknown
  });
});

describe("normalizeTaf (live-captured fixture)", () => {
  const tafs = fixture("awc-taf-json.json") as Record<string, unknown>[];
  const groups = normalizeTaf(tafs[0]!);

  it("decomposes into ordered change groups with epoch->ISO windows", () => {
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]!.groupType).toBe("BASE");
    for (const g of groups) {
      expect(Date.parse(g.validFrom)).toBeLessThan(Date.parse(g.validTo));
    }
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i]!.groupSeq).toBe(i);
    }
  });

  it("every group carries the full raw TAF for provenance", () => {
    for (const g of groups) expect(g.rawText).toMatch(/^TAF|^KOAK|^KSTL|^KRNO/);
  });

  it("PROB groups are typed PROB with their percentage", () => {
    const synthetic = normalizeTaf({
      icaoId: "KTST", issueTime: "2026-07-18T03:00:00Z", rawTAF: "TAF KTST ...",
      fcsts: [
        { timeFrom: 1784343600, timeTo: 1784350800, fcstChange: null },
        { timeFrom: 1784343600, timeTo: 1784350800, probability: 30, fcstChange: null, wxString: "TSRA" },
        { timeFrom: 1784350800, timeTo: 1784358000, fcstChange: "TEMPO", wxString: "SHRA" },
      ],
    });
    expect(synthetic[1]!.groupType).toBe("PROB");
    expect(synthetic[1]!.probability).toBe(30);
    expect(synthetic[2]!.groupType).toBe("TEMPO");
  });
});

describe("normalizePirep (live-captured fixture)", () => {
  const pireps = (fixture("awc-pirep-json.json") as Record<string, unknown>[])
    .map(normalizePirep)
    .filter((p) => p !== null);

  it("parses the large majority of live reports", () => {
    expect(pireps.length).toBeGreaterThan(50);
  });

  it("flight level is hundreds of feet MSL (FL340 -> 34000)", () => {
    const high = pireps.find((p) => p!.rawText.includes("FL340"))!;
    expect(high.altitudeFtMsl).toBe(34000);
  });

  it("turbulence intensity captured with aircraft type retained", () => {
    const turb = pireps.find((p) => p!.turbulence.length > 0)!;
    expect(turb.turbulence[0]!.intensity).toBeTruthy();
    expect(turb.aircraftType).toBeTruthy();
  });

  it("UUA raw text marks the report urgent", () => {
    const n = normalizePirep({
      obsTime: 1784350000, lat: 39, lon: -100,
      rawOb: "DEN UUA /OV DEN/TM 0400/FL080/TP BE36/TB SEV",
      pirepType: "PIREP", fltLvl: 80, tbInt1: "SEV",
    })!;
    expect(n.urgent).toBe(true);
    expect(n.altitudeFtMsl).toBe(8000);
  });
});
