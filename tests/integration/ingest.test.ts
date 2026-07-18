import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FetchCoordinator } from "@/lib/ingest/coordinator";
import { ingestMetars, ingestPireps, ingestTafs } from "@/lib/ingest/awc";
import { freshnessOf } from "@/lib/wx/freshness";

// Full ingestion round-trip on a real database using the captured live
// fixtures served through a stubbed network: fetch -> normalize -> store ->
// inspect, idempotency, and the failure path (M3 acceptance criteria).

const TEST_BASE = "https://fixtures.test/api/data";

const fixtureBody = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "fixtures", "upstream", name),
    "utf8",
  );

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

function fixtureCoordinator(overrides: Record<string, () => Response> = {}) {
  return new FetchCoordinator({
    fetchImpl: async (input) => {
      const u = String(input);
      for (const [needle, make] of Object.entries(overrides)) {
        if (u.includes(needle)) return make();
      }
      if (u.includes("/metar")) return new Response(fixtureBody("awc-metar-json.json"));
      if (u.includes("/taf")) return new Response(fixtureBody("awc-taf-json.json"));
      if (u.includes("/pirep")) return new Response(fixtureBody("awc-pirep-json.json"));
      return new Response("", { status: 204 });
    },
  });
}

describe.skipIf(!sql)("weather ingestion round-trip", () => {
  beforeAll(async () => {
    await sql!`DELETE FROM source_records WHERE upstream_url LIKE ${TEST_BASE + "%"}`;
  });

  afterAll(async () => {
    await sql!`DELETE FROM source_records WHERE upstream_url LIKE ${TEST_BASE + "%"}`;
    await sql!.end();
  });

  it("ingests METARs: provenance row + normalized row per station", async () => {
    const r = await ingestMetars(sql!, fixtureCoordinator(), { ids: ["KSTL", "KOAK", "KRNO"] }, TEST_BASE);
    expect(r.state).toBe("fresh");
    expect(r.fetched).toBe(3);
    expect(r.stored).toBe(3);
    const [obs] = await sql!`
      SELECT o.*, s.upstream_url FROM weather_observations o
      JOIN source_records s ON s.id = o.source_record_id
      WHERE o.station = 'KRNO' AND s.upstream_url LIKE ${TEST_BASE + "%"}
    `;
    expect(obs).toBeDefined();
    expect(Number(obs!.visibility_sm)).toBe(10);
    expect(obs!.raw_text).toMatch(/^METAR KRNO/);
  });

  it("re-ingesting the same data stores nothing new (idempotent)", async () => {
    const r = await ingestMetars(sql!, fixtureCoordinator(), { ids: ["KSTL", "KOAK", "KRNO"] }, TEST_BASE);
    expect(r.fetched).toBe(3);
    expect(r.stored).toBe(0);
  });

  it("ingests TAFs as change-group rows under one record", async () => {
    const r = await ingestTafs(sql!, fixtureCoordinator(), { ids: ["KSTL", "KOAK", "KRNO"] }, TEST_BASE);
    expect(r.stored).toBeGreaterThan(0);
    const groups = await sql!`
      SELECT f.* FROM weather_forecasts f
      JOIN source_records s ON s.id = f.source_record_id
      WHERE s.upstream_url LIKE ${TEST_BASE + "%"} AND f.station = 'KSTL'
      ORDER BY f.group_seq
    `;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]!.group_type).toBe("BASE");
  });

  it("ingests PIREPs with geometry usable for proximity queries", async () => {
    const r = await ingestPireps(sql!, fixtureCoordinator(), { bboxes: ["35,-115,45,-90"] }, TEST_BASE);
    expect(r.stored).toBeGreaterThan(50);
    // A PIREP fixture point near Colorado Springs should be findable by distance.
    const near = await sql!`
      SELECT count(*)::int AS n FROM pireps p
      JOIN source_records s ON s.id = p.source_record_id
      WHERE s.upstream_url LIKE ${TEST_BASE + "%"}
        AND ST_DWithin(p.geom,
          ST_SetSRID(ST_MakePoint(-104.7, 38.8), 4326)::geography, ${50 * 1852})
    `;
    expect(near[0]!.n).toBeGreaterThan(0);
  });

  it("a failed source reports failed — it never pretends to be data", async () => {
    const failing = fixtureCoordinator({
      "/metar": () => {
        throw new Error("upstream down");
      },
    });
    const r = await ingestMetars(sql!, failing, { ids: ["KSTL"] }, TEST_BASE + "/down");
    expect(r.state).toBe("failed");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.stored).toBe(0);
  });

  it("freshness policy: 4h-old METAR stale, 2h aging, 30min fresh", () => {
    const now = new Date("2026-07-18T06:00:00Z");
    expect(freshnessOf("METAR", "2026-07-18T02:00:00Z", now)).toBe("stale");
    expect(freshnessOf("METAR", "2026-07-18T04:00:00Z", now)).toBe("aging");
    expect(freshnessOf("METAR", "2026-07-18T05:30:00Z", now)).toBe("fresh");
    expect(freshnessOf("METAR", null, now)).toBe("stale");
  });
});
