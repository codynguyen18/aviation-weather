import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseAirportsCsv,
  parseNavaidsCsv,
  parseRunwaysCsv,
} from "@/lib/nav/ourairports";
import { parseLatLon } from "@/lib/nav/resolver";

const fixture = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "fixtures", "navdata", name),
    "utf8",
  );

describe("parseAirportsCsv", () => {
  const airports = parseAirportsCsv(fixture("airports.csv"));

  it("parses every fixture row with coordinates", () => {
    expect(airports.length).toBe(12);
  });

  it("KSTL carries all its codes", () => {
    const kstl = airports.find((a) => a.ident === "KSTL")!;
    expect(kstl.icaoCode).toBe("KSTL");
    expect(kstl.iataCode).toBe("STL");
    expect(kstl.name).toMatch(/Lambert/);
    expect(kstl.scheduledService).toBe(true);
    expect(kstl.elevationFt).toBeGreaterThan(500);
    expect(kstl.lat).toBeCloseTo(38.7487, 2);
  });

  it("KO22 has gps/local codes but no ICAO (US small-field quirk)", () => {
    const o22 = airports.find((a) => a.ident === "KO22")!;
    expect(o22.icaoCode).toBeNull();
    expect(o22.gpsCode).toBe("O22");
    expect(o22.localCode).toBe("O22");
    expect(o22.type).toBe("small_airport");
  });

  it("missing elevation and codes become null, not zero or empty string", () => {
    const csv = [
      '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"',
      '1,"XTEST","small_airport","Test Field",40.0,-100.0,,"NA","US","US-KS","Nowhere","no",,,,,,,',
    ].join("\n");
    const [a] = parseAirportsCsv(csv);
    expect(a).toBeDefined();
    expect(a!.elevationFt).toBeNull();
    expect(a!.icaoCode).toBeNull();
    expect(a!.iataCode).toBeNull();
  });

  it("rows without coordinates are skipped entirely", () => {
    const csv = [
      '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"',
      '1,"XNOCO","small_airport","No Coords",,,"","NA","US","US-KS","Nowhere","no",,,,,,,',
    ].join("\n");
    expect(parseAirportsCsv(csv)).toHaveLength(0);
  });
});

describe("parseRunwaysCsv", () => {
  const runways = parseRunwaysCsv(fixture("runways.csv"));

  it("parses fixture rows", () => {
    expect(runways.length).toBe(30);
  });

  it("KSTL's longest runway is 11,020 ft, lighted, not closed", () => {
    const kstl = runways.filter((r) => r.airportIdent === "KSTL");
    const longest = Math.max(...kstl.map((r) => r.lengthFt ?? 0));
    expect(longest).toBe(11020);
    const main = kstl.find((r) => r.lengthFt === longest)!;
    expect(main.lighted).toBe(true);
    expect(main.closed).toBe(false);
  });
});

describe("parseNavaidsCsv", () => {
  const navaids = parseNavaidsCsv(fixture("navaids.csv"));

  it("parses fixture rows including duplicate idents", () => {
    expect(navaids.length).toBe(5);
    expect(navaids.filter((n) => n.ident === "STJ").length).toBe(2);
  });

  it("STL VORTAC has frequency and US country", () => {
    const stl = navaids.find((n) => n.ident === "STL")!;
    expect(stl.type).toBe("VORTAC");
    expect(stl.frequencyKhz).toBeGreaterThan(100_000);
    expect(stl.isoCountry).toBe("US");
  });
});

describe("parseLatLon", () => {
  it("accepts decimal degrees with optional spaces", () => {
    expect(parseLatLon("38.75,-90.37")).toEqual({ lat: 38.75, lon: -90.37 });
    expect(parseLatLon(" 39.5 , -119.8 ")).toEqual({ lat: 39.5, lon: -119.8 });
  });

  it("rejects out-of-range and non-coordinate input", () => {
    expect(parseLatLon("95,-90")).toBeNull();
    expect(parseLatLon("38.75,-190")).toBeNull();
    expect(parseLatLon("KSTL")).toBeNull();
    expect(parseLatLon("")).toBeNull();
  });
});
