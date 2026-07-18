import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { buildRoute } from "@/lib/route/engine";
import { corridorsFor } from "@/lib/route/corridor";
import type { RouteOptions, RouteWaypoint } from "@/lib/route/types";

// Corridor geometry truth tests on real PostGIS (M2 acceptance criteria):
// geodesic buffer areas match theory at CONUS latitudes, and points known to
// be inside/outside the corridor classify correctly (the near-miss discipline
// every hazard-intersection rule will inherit).

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

const KSTL: RouteWaypoint = {
  kind: "airport", ident: "KSTL", name: "STL", lat: 38.748697,
  lon: -90.370028, elevationFt: 618, type: "large_airport", isoCountry: "US",
  municipality: null, navSource: "test", isFuelStop: false, groundMinutes: 0,
};
const KOAK: RouteWaypoint = {
  kind: "airport", ident: "KOAK", name: "OAK", lat: 37.721278,
  lon: -122.220722, elevationFt: 13, type: "large_airport", isoCountry: "US",
  municipality: null, navSource: "test", isFuelStop: false, groundMinutes: 0,
};

const OPTS: RouteOptions = {
  departureTimeUtc: "2026-07-18T13:00:00Z",
  cruiseAltitudeFt: 10500,
  performance: {
    cruiseTasKt: 165, climbRateFpm: 900, climbTasKt: 130,
    descentRateFpm: 500, descentTasKt: 140,
  },
  segmentMaxNm: 50,
  corridorWidthNm: 25,
};

describe.skipIf(!sql)("route corridors in PostGIS", () => {
  afterAll(async () => {
    await sql!.end();
  });

  it("corridor area matches 2wL + πw² within 2% for a 50 nm segment", async () => {
    const model = buildRoute([KSTL, KOAK], OPTS);
    const mid = model.segments[Math.floor(model.segments.length / 2)]!;
    const [corridor] = await corridorsFor(sql!, [mid], 25);
    expect(corridor).toBeDefined();
    const w = 25;
    const L = mid.distanceNm;
    const theory = 2 * w * L + Math.PI * w * w;
    expect(Math.abs(corridor!.areaSqNm - theory) / theory).toBeLessThan(0.02);
  });

  it("one corridor polygon per segment, in order", async () => {
    const model = buildRoute([KSTL, KOAK], OPTS);
    const corridors = await corridorsFor(sql!, model.segments, 25);
    expect(corridors.length).toBe(model.segments.length);
    expect(corridors.map((c) => c.seq)).toEqual(
      model.segments.map((s) => s.seq),
    );
  });

  it("20 nm off-track is inside a 25 nm corridor; 30 nm is outside", async () => {
    const model = buildRoute([KSTL, KOAK], OPTS);
    const seg = model.segments[5]!;
    // Walk perpendicular from the segment midpoint using PostGIS itself.
    const [midRow] = await sql!`
      SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lon FROM (
        SELECT ST_LineInterpolatePoint(
          ST_GeomFromText(${`LINESTRING(${seg.points
            .map(([lon, lat]) => `${lon} ${lat}`)
            .join(",")})`}, 4326), 0.5) AS p
      ) q
    `;
    const az = ((await sql!`
      SELECT degrees(ST_Azimuth(
        ST_SetSRID(ST_MakePoint(${seg.startLon}, ${seg.startLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${seg.endLon}, ${seg.endLat}), 4326)::geography
      )) AS az
    `)[0]!.az as number) + 90; // perpendicular

    const test = async (offsetNm: number) => {
      const [pt] = await sql!`
        SELECT ST_Project(
          ST_SetSRID(ST_MakePoint(${midRow!.lon}, ${midRow!.lat}), 4326)::geography,
          ${offsetNm * 1852}::float8, radians(${az}::float8)) AS g
      `;
      const [hit] = await sql!`
        SELECT ST_Intersects(
          ST_Buffer(ST_GeogFromText(${`LINESTRING(${seg.points
            .map(([lon, lat]) => `${lon} ${lat}`)
            .join(",")})`}), ${25 * 1852}),
          ${pt!.g}::geography
        ) AS hit
      `;
      return Boolean(hit!.hit);
    };

    expect(await test(20)).toBe(true);
    expect(await test(30)).toBe(false);
  });
});
