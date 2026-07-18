import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { greatCircleMeters, METERS_PER_NM } from "@/lib/geo";

// Proves the deployed database really has working PostGIS and that its
// spheroidal geometry agrees with our spherical display math within the
// documented ~0.5% (PLAN.md §24 acceptance criterion, corrected distance).
//
// Requires DATABASE_URL pointing at a PostGIS-enabled Postgres with
// migrations applied (CI provides one; locally: docker compose up db).

const KSTL = { lat: 38.748697, lon: -90.370028 };
const KOAK = { lat: 37.721278, lon: -122.220722 };

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)("PostGIS geodesic round-trip", () => {
  beforeAll(async () => {
    await sql!`CREATE EXTENSION IF NOT EXISTS postgis`;
  });

  afterAll(async () => {
    await sql!.end();
  });

  it("reports a PostGIS version", async () => {
    const rows = await sql!`SELECT postgis_version() AS v`;
    expect(rows[0]?.v).toMatch(/^3\./);
  });

  it("KSTL -> KOAK geography distance is ~1496 nm on the spheroid", async () => {
    const rows = await sql!`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(${KSTL.lon}, ${KSTL.lat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${KOAK.lon}, ${KOAK.lat}), 4326)::geography
      ) AS meters
    `;
    const nm = Number(rows[0]?.meters) / METERS_PER_NM;
    expect(nm).toBeGreaterThan(1488);
    expect(nm).toBeLessThan(1504);
  });

  it("spheroidal (PostGIS) and spherical (app) distances agree within 0.5%", async () => {
    const rows = await sql!`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(${KSTL.lon}, ${KSTL.lat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${KOAK.lon}, ${KOAK.lat}), 4326)::geography
      ) AS meters
    `;
    const postgisMeters = Number(rows[0]?.meters);
    const appMeters = greatCircleMeters(KSTL, KOAK);
    const relativeError = Math.abs(postgisMeters - appMeters) / postgisMeters;
    expect(relativeError).toBeLessThan(0.005);
  });

  it("migration bookkeeping table exists", async () => {
    const rows = await sql!`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'app_migrations'
    `;
    expect(rows[0]?.n).toBe(1);
  });
});
