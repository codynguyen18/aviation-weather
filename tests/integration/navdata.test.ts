import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importOurAirports } from "@/lib/nav/import";
import { airportsNear, resolveIdent, searchWaypoints } from "@/lib/nav/resolver";

// End-to-end over a real PostGIS database: import the fixture navdata
// snapshot, then exercise resolution, ambiguity, spatial queries, and the
// atomic dataset swap (M1 acceptance criteria, PLAN.md §20).

const fixture = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "fixtures", "navdata", name),
    "utf8",
  );

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)("navdata import + resolver", () => {
  beforeAll(async () => {
    const input = {
      airportsCsv: fixture("airports.csv"),
      runwaysCsv: fixture("runways.csv"),
      navaidsCsv: fixture("navaids.csv"),
      versionLabel: "test-fixture",
      prune: false,
    };
    await importOurAirports(sql!, input);
  });

  afterAll(async () => {
    // Remove test datasets AND hand the active flag back to the newest real
    // dataset if one exists — otherwise a test run would leave a previously
    // imported production snapshot silently deactivated.
    await sql!`DELETE FROM nav_datasets WHERE version_label LIKE 'test-%'`;
    await sql!`
      UPDATE nav_datasets SET active = true
      WHERE id = (
        SELECT id FROM nav_datasets WHERE source = 'ourairports'
        ORDER BY imported_at DESC LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM nav_datasets WHERE source = 'ourairports' AND active
      )
    `;
    await sql!.end();
  });

  it("KSTL resolves directly to the airport despite the STL VORTAC existing", async () => {
    const r = await resolveIdent(sql!, "KSTL");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.waypoint.kind).toBe("airport");
      expect(r.waypoint.name).toMatch(/Lambert/);
      expect(r.waypoint.navSource).toBe("ourairports@test-fixture");
    }
  });

  it("O22 resolves via gps/local code (no ICAO on file)", async () => {
    const r = await resolveIdent(sql!, "o22");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.waypoint.ident).toBe("KO22");
      expect(r.waypoint.name).toMatch(/Columbia/);
    }
  });

  it("lat/lon input resolves without touching the database", async () => {
    const r = await resolveIdent(sql!, "39.5,-119.8");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.waypoint.kind).toBe("latlon");
      expect(r.waypoint.lat).toBe(39.5);
    }
  });

  it("STL is ambiguous: KSTL (IATA), a Mexican strip, and the VORTAC", async () => {
    const r = await resolveIdent(sql!, "STL");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      const kinds = r.candidates.map((c) => `${c.kind}:${c.ident}`);
      expect(kinds).toContain("airport:KSTL");
      expect(kinds).toContain("navaid:STL");
      expect(r.candidates.length).toBeGreaterThanOrEqual(3);
      // US airline-served airport should be offered first
      expect(r.candidates[0]!.ident).toBe("KSTL");
    }
  });

  it("STJ is ambiguous between two navaids sharing the ident", async () => {
    const r = await resolveIdent(sql!, "STJ");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates.every((c) => c.kind === "navaid")).toBe(true);
      expect(r.candidates.length).toBe(2);
    }
  });

  it("unknown ident is not-found, never a guess", async () => {
    const r = await resolveIdent(sql!, "ZZZQ9");
    expect(r.status).toBe("not-found");
  });

  it("airports near St. Louis include KSTL, KCPS, and KSUS with sane distances", async () => {
    const near = await airportsNear(sql!, 38.7487, -90.37, 30);
    const idents = near.map((a) => a.ident);
    expect(idents).toContain("KSTL");
    expect(idents).toContain("KCPS");
    expect(idents).toContain("KSUS");
    const kstl = near.find((a) => a.ident === "KSTL")!;
    expect(kstl.distanceNm).toBeLessThan(1);
    expect(kstl.longestRunwayFt).toBe(11020);
    // sorted by distance
    const distances = near.map((a) => a.distanceNm);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it("near-query excludes closed airports and heliports", async () => {
    const near = await airportsNear(sql!, 38.7487, -90.37, 200, 100);
    expect(near.every((a) => a.type.endsWith("_airport"))).toBe(true);
  });

  it("typeahead finds Oakland by name prefix and excludes closed fields", async () => {
    const results = await searchWaypoints(sql!, "oakl");
    expect(results.some((w) => w.ident === "KOAK")).toBe(true);
    expect(results.every((w) => w.type !== "closed")).toBe(true);
  });

  it("re-import atomically swaps the active dataset", async () => {
    const input = {
      airportsCsv: fixture("airports.csv"),
      runwaysCsv: fixture("runways.csv"),
      navaidsCsv: fixture("navaids.csv"),
      versionLabel: "test-fixture-2",
      prune: false,
    };
    await importOurAirports(sql!, input);
    const active = await sql!`
      SELECT version_label FROM nav_datasets
      WHERE source = 'ourairports' AND active
    `;
    expect(active.length).toBe(1);
    expect(active[0]!.version_label).toBe("test-fixture-2");
    // resolution still works against the new dataset
    const r = await resolveIdent(sql!, "KSTL");
    expect(r.status).toBe("resolved");
  });
});
