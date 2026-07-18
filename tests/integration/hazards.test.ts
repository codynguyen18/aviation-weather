import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FetchCoordinator } from "@/lib/ingest/coordinator";
import { ingestHazardProduct, ingestWindtemp } from "@/lib/ingest/hazards";
import { buildRoute } from "@/lib/route/engine";
import type { RouteOptions, RouteWaypoint } from "@/lib/route/types";
import { hazardsForSegment } from "@/lib/wx/intersect";
import { loadWindField } from "@/lib/wx/winds";
import { importOurAirports } from "@/lib/nav/import";

const TEST_BASE = "https://fixtures.test/api/data";

const fixtureBody = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", name),
    "utf8",
  );
const navFixture = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "fixtures", "navdata", name),
    "utf8",
  );

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

// Synthetic FB bulletin with stations resolvable from the navdata fixtures
// (STL VORTAC near St. Louis, FMG VORTAC near Reno). Deterministic winds:
// strong westerlies aloft -> headwind for a westbound route.
const SYNTHETIC_FB = `(Extracted from FBUS31 KWNO 180159)
FD1US1
DATA BASED ON 180000Z
VALID 180600Z   FOR USE 0200-0900Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
STL 2710 2720+15 2730+10 2740+05 2750-05 2760-15 277031 277541 278053
FMG 2712 2722+12 2732+08 2742+02 2752-08 2762-18 277232 277742 278254
`;

const KSTL: RouteWaypoint = {
  kind: "airport", ident: "KSTL", name: "STL", lat: 38.748697, lon: -90.370028,
  elevationFt: 618, type: "large_airport", isoCountry: "US", municipality: null,
  navSource: "test", isFuelStop: false, groundMinutes: 0,
};
const KOAK: RouteWaypoint = {
  kind: "airport", ident: "KOAK", name: "OAK", lat: 37.721278, lon: -122.220722,
  elevationFt: 13, type: "large_airport", isoCountry: "US", municipality: null,
  navSource: "test", isFuelStop: false, groundMinutes: 0,
};
const OPTS: RouteOptions = {
  departureTimeUtc: "2026-07-18T02:30:00Z", // inside the FB for-use window
  cruiseAltitudeFt: 10500,
  performance: {
    cruiseTasKt: 165, climbRateFpm: 900, climbTasKt: 130,
    descentRateFpm: 500, descentTasKt: 140,
  },
  segmentMaxNm: 50,
  corridorWidthNm: 25,
};

function coordFor() {
  return new FetchCoordinator({
    fetchImpl: async (input) => {
      const u = String(input);
      if (u.includes("/airsigmet")) return new Response(fixtureBody("awc-airsigmet-geojson.geojson"));
      if (u.includes("/gairmet")) return new Response(fixtureBody("awc-gairmet-geojson.geojson"));
      if (u.includes("/cwa")) return new Response(fixtureBody("awc-cwa-geojson.geojson"));
      if (u.includes("/windtemp")) return new Response(SYNTHETIC_FB);
      return new Response("", { status: 204 });
    },
  });
}

describe.skipIf(!sql)("hazard + winds ingestion and intersection", () => {
  beforeAll(async () => {
    await sql!`DELETE FROM source_records WHERE upstream_url LIKE ${TEST_BASE + "%"}`;
    await importOurAirports(sql!, {
      airportsCsv: navFixture("airports.csv"),
      runwaysCsv: navFixture("runways.csv"),
      navaidsCsv: navFixture("navaids.csv"),
      versionLabel: "test-m4",
      prune: false,
    });
  });

  afterAll(async () => {
    await sql!`DELETE FROM source_records WHERE upstream_url LIKE ${TEST_BASE + "%"}`;
    await sql!`DELETE FROM nav_datasets WHERE version_label LIKE 'test-%'`;
    await sql!`
      UPDATE nav_datasets SET active = true
      WHERE id = (SELECT id FROM nav_datasets WHERE source='ourairports' ORDER BY imported_at DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM nav_datasets WHERE source='ourairports' AND active)
    `;
    await sql!.end();
  });

  it("ingests captured SIGMETs/G-AIRMETs into valid geometries", async () => {
    const a = await ingestHazardProduct(sql!, coordFor(), "airsigmet", TEST_BASE);
    const g = await ingestHazardProduct(sql!, coordFor(), "gairmet", TEST_BASE);
    const c = await ingestHazardProduct(sql!, coordFor(), "cwa", TEST_BASE);
    expect(a.stored).toBeGreaterThan(0);
    expect(g.stored).toBeGreaterThan(0);
    expect(c.stored).toBe(0); // captured CWA file was an empty FeatureCollection
    // Note: G-AIRMET freezing-level features are LINES (zero area) — that is
    // correct data, so assert polygons have area rather than the minimum.
    const [chk] = await sql!`
      SELECT count(*)::int AS n, max(ST_Area(geom)) AS max_area
      FROM hazard_geometries h JOIN source_records s ON s.id = h.source_record_id
      WHERE s.upstream_url LIKE ${TEST_BASE + "%"}
    `;
    expect(chk!.n).toBeGreaterThan(0);
    expect(Number(chk!.max_area)).toBeGreaterThan(0);
  });

  it("three-gate intersection: space + time + altitude must all pass", async () => {
    const model = buildRoute([KSTL, KOAK], OPTS);
    const seg = model.segments[10]!; // mid-Kansas-ish
    const mid = seg.points[Math.floor(seg.points.length / 2)]!;
    const poly = (dLon: number) => JSON.stringify({
      type: "Polygon",
      coordinates: [[
        [mid[0] - 0.5 + dLon, mid[1] - 0.5], [mid[0] + 0.5 + dLon, mid[1] - 0.5],
        [mid[0] + 0.5 + dLon, mid[1] + 0.5], [mid[0] - 0.5 + dLon, mid[1] + 0.5],
        [mid[0] - 0.5 + dLon, mid[1] - 0.5],
      ]],
    });
    const insert = async (key: string, geojson: string, floor: number | null, ceiling: number | null, from: string, to: string) => {
      const [rec] = await sql!`
        INSERT INTO source_records (source_type, external_key, issued_at, valid_from, valid_to, upstream_url, raw)
        VALUES ('AIRSIGMET', ${"TEST-" + key}, ${from}, ${from}, ${to}, ${TEST_BASE + "/synthetic"}, '{}')
        RETURNING id`;
      await sql!`
        INSERT INTO hazard_geometries (source_record_id, product, hazard, geom, floor_ft_msl, ceiling_ft_msl, valid_from, valid_to)
        VALUES (${rec!.id}, 'AIRSIGMET', 'CONVECTIVE',
                ST_GeomFromGeoJSON(${geojson})::geography, ${floor}, ${ceiling}, ${from}, ${to})`;
    };
    const entry = seg.time.entryUtc;
    const exit = seg.time.exitUtc;
    const wayBefore = new Date(Date.parse(entry) - 6 * 3_600_000).toISOString();
    const before = new Date(Date.parse(entry) - 2 * 3_600_000).toISOString();

    await insert("hit", poly(0), 0, 45000, entry, exit);            // all gates pass
    await insert("timemiss", poly(0), 0, 45000, wayBefore, before); // expired at ETA
    await insert("altmiss", poly(0), 30000, 45000, entry, exit);    // FL300+ only
    await insert("spacemiss", poly(8), 0, 45000, entry, exit);      // ~8 deg east

    const hits = await hazardsForSegment(sql!, seg, {
      corridorWidthNm: 25, altitudeBandFt: 4000, timeBufferMin: 30,
    });
    const keys = hits.map((h) => h.hazardId);
    expect(keys.length).toBe(1);
    expect(hits[0]!.clipNm).toBeGreaterThan(0);
    expect(hits[0]!.hazard).toBe("CONVECTIVE");
  });

  it("winds ingest + lookup produce a headwind that slows the westbound route", async () => {
    const w = await ingestWindtemp(sql!, coordFor(), ["06"], TEST_BASE, new Date("2026-07-18T02:00:00Z"));
    expect(w.stored).toBe(18); // 2 stations x 9 levels

    const field = await loadWindField(sql!, {
      from: new Date("2026-07-18T02:00:00Z"),
      to: new Date("2026-07-18T12:00:00Z"),
    });
    expect(field.stations).toBeGreaterThanOrEqual(2);

    // Near St. Louis at 10,500 ft: interpolated between 9000 (270/30) and
    // 12000 (270/40) -> 270 deg at 35 kt.
    const wind = field.at(38.86, -90.48, 10500, new Date("2026-07-18T03:00:00Z"))!;
    expect(wind).not.toBeNull();
    expect(wind.dirDeg).toBe(270);
    expect(wind.speedKt).toBeCloseTo(35, 0);

    // Far from any station -> null (flagged unavailable, not silently zero).
    expect(field.at(30.0, -85.0, 9000, new Date("2026-07-18T03:00:00Z"))).toBeNull();

    const zeroWind = buildRoute([KSTL, KOAK], OPTS);
    const withWind = buildRoute([KSTL, KOAK], OPTS, field.at);
    expect(withWind.engine.wind).toBe("fb-winds");
    expect(withWind.totals.airborneMinutes).toBeGreaterThan(
      zeroWind.totals.airborneMinutes + 30,
    );
    const first = withWind.segments[0]!;
    expect(first.windSource).toBe("fb");
    expect(first.headwindKt).toBeGreaterThan(0); // westbound into westerlies
  });
});
