import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FetchCoordinator } from "@/lib/ingest/coordinator";
import { briefingRequestSchema, generateBriefing } from "@/lib/briefing/generate";
import { importOurAirports } from "@/lib/nav/import";

// End-to-end briefing generation on a real database with the captured live
// fixtures served through a stubbed network (M5 acceptance criteria):
// resolve -> route -> refresh -> winds -> rules -> immutable snapshot.

const TEST_BASE = "https://fixtures.test/api/data";
const NWS_BASE = "https://fixtures.test/nws";

const fixtureBody = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", name), "utf8");
const navFixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "fixtures", "navdata", name), "utf8");

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

// Fixed clock aligned with the captured fixtures (METARs ~03:55Z Jul 18).
const NOW = new Date("2026-07-18T04:10:00Z");

const SYNTHETIC_FB = `(Extracted from FBUS31 KWNO 180159)
FD1US1
DATA BASED ON 180000Z
VALID 180600Z   FOR USE 0200-0900Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
STL 2710 2720+15 2730+10 2740+05 2750-05 2760-15 277031 277541 278053
FMG 2712 2722+12 2732+08 2742+02 2752-08 2762-18 277232 277742 278254
`;

function fullCoordinator(overrides: Record<string, () => Response> = {}) {
  return new FetchCoordinator({
    fetchImpl: async (input) => {
      const u = String(input);
      for (const [needle, make] of Object.entries(overrides)) {
        if (u.includes(needle)) return make();
      }
      if (u.includes("/metar")) return new Response(fixtureBody("awc-metar-json.json"));
      if (u.includes("/taf")) return new Response(fixtureBody("awc-taf-json.json"));
      if (u.includes("/pirep")) return new Response(fixtureBody("awc-pirep-json.json"));
      if (u.includes("/airsigmet")) return new Response(fixtureBody("awc-airsigmet-geojson.geojson"));
      if (u.includes("/gairmet")) return new Response(fixtureBody("awc-gairmet-geojson.geojson"));
      if (u.includes("/cwa")) return new Response(fixtureBody("awc-cwa-geojson.geojson"));
      if (u.includes("/windtemp")) return new Response(SYNTHETIC_FB);
      if (u.includes("/points/")) return new Response(JSON.stringify({ properties: { gridId: "LSX" } }));
      if (u.includes("/products/types/AFD/")) return new Response(fixtureBody("nws-afd-rev-latest.json"));
      return new Response("", { status: 204 });
    },
  });
}

const REQUEST = briefingRequestSchema.parse({
  waypoints: [
    { ident: "KSTL" },
    { ident: "KRNO", isFuelStop: true, groundMinutes: 45 },
    { ident: "KOAK" },
  ],
  departureTimeUtc: "2026-07-18T04:30:00Z",
  cruiseAltitudeFt: 10500,
  performance: {
    cruiseTasKt: 165, climbRateFpm: 900, climbTasKt: 130,
    descentRateFpm: 500, descentTasKt: 140,
  },
  minimums: { nightOk: true }, // overnight departure; keep night rule quiet
  aircraft: { fuelEnduranceMin: 600 }, // long-range tanks: the KSTL-KRNO hop is ~8.8 h
});

describe.skipIf(!sql)("briefing generation end-to-end", () => {
  beforeAll(async () => {
    // Full weather wipe for determinism: a shared dev DB may hold live-
    // ingested products whose validity overlaps this test's fixed clock.
    await sql!`DELETE FROM briefing_snapshots`;
    await sql!`DELETE FROM source_records WHERE source_type IN
      ('METAR','TAF','PIREP','AIRSIGMET','GAIRMET','CWA','WINDTEMP','AFD')`;
    await importOurAirports(sql!, {
      airportsCsv: navFixture("airports.csv"),
      runwaysCsv: navFixture("runways.csv"),
      navaidsCsv: navFixture("navaids.csv"),
      versionLabel: "test-m5",
      prune: false,
    });
  });

  afterAll(async () => {
    await sql!`DELETE FROM briefing_snapshots`;
    await sql!`DELETE FROM source_records WHERE upstream_url LIKE 'https://fixtures.test%'`;
    await sql!`DELETE FROM nav_datasets WHERE version_label LIKE 'test-%'`;
    await sql!`
      UPDATE nav_datasets SET active = true
      WHERE id = (SELECT id FROM nav_datasets WHERE source='ourairports' ORDER BY imported_at DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM nav_datasets WHERE source='ourairports' AND active)
    `;
    await sql!.end();
  });

  it("upstream outage -> partial briefing with unknown terminal segments", async () => {
    const broken = fullCoordinator({
      "/metar": () => { throw new Error("upstream down"); },
      "/taf": () => { throw new Error("upstream down"); },
    });
    const r = await generateBriefing(sql!, broken, REQUEST, {
      awcBaseUrl: TEST_BASE + "/broken", nwsBaseUrl: NWS_BASE, now: NOW,
    });
    expect(r.status).toBe("partial");
    expect(r.partialReasons.join(" ")).toMatch(/METAR/);
    // Departure segment has no observations/TAF -> unknown, not green.
    expect(r.assessments[0]!.rating).toBe("unknown");
  });

  it("full generation: snapshot, ratings, winds, and provenance", async () => {
    const r = await generateBriefing(sql!, fullCoordinator(), REQUEST, {
      awcBaseUrl: TEST_BASE, nwsBaseUrl: NWS_BASE, now: NOW,
    });
    expect(r.status).toBe("complete");
    expect(r.route.engine.wind).toBe("fb-winds");
    expect(r.assessments.length).toBe(r.route.segments.length);

    // Departure segment: terminal rules ran against the real KSTL fixtures.
    const dep = r.assessments[0]!;
    const ceiling = dep.evaluations.find((e) => e.ruleId === "ceiling-below-minimum");
    expect(ceiling).toBeDefined();
    expect(["pass", "red", "unknown"]).toContain(ceiling!.result);
    expect(ceiling!.sourceRecordIds.length).toBeGreaterThan(0);

    // Wind-adjusted westbound flight into synthetic westerlies is slower.
    const first = r.route.segments[0]!;
    expect(first.windSource).toBe("fb");
    expect(first.headwindKt).toBeGreaterThan(0);

    // Snapshot persisted with linked evidence.
    const [snap] = await sql!`
      SELECT status, trip_summary FROM briefing_snapshots WHERE id = ${r.snapshotId}
    `;
    expect(snap!.status).toBe("complete");
    const [links] = await sql!`
      SELECT count(*)::int AS n FROM briefing_source_links WHERE snapshot_id = ${r.snapshotId}
    `;
    expect(links!.n).toBeGreaterThan(0);
    const [evals] = await sql!`
      SELECT count(*)::int AS n FROM rule_evaluations WHERE snapshot_id = ${r.snapshotId}
    `;
    expect(evals!.n).toBeGreaterThan(0);
  });

  it("regeneration creates a NEW snapshot; the old one is untouched", async () => {
    const a = await generateBriefing(sql!, fullCoordinator(), REQUEST, {
      awcBaseUrl: TEST_BASE, nwsBaseUrl: NWS_BASE, now: NOW,
    });
    const before = await sql!`
      SELECT rating FROM segment_assessments WHERE snapshot_id = ${a.snapshotId} ORDER BY segment_seq
    `;
    const b = await generateBriefing(sql!, fullCoordinator(), REQUEST, {
      awcBaseUrl: TEST_BASE, nwsBaseUrl: NWS_BASE, now: NOW,
    });
    expect(b.snapshotId).not.toBe(a.snapshotId);
    const after = await sql!`
      SELECT rating FROM segment_assessments WHERE snapshot_id = ${a.snapshotId} ORDER BY segment_seq
    `;
    expect(after.map((x) => x.rating)).toEqual(before.map((x) => x.rating));
  });
});
