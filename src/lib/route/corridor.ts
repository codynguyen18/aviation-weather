import type { Sql } from "postgres";

import { METERS_PER_NM } from "@/lib/geo";
import type { RouteSegment } from "@/lib/route/types";

// Geodesic corridor polygons around route segments, computed in PostGIS on
// geography — the authoritative geometry engine (PLAN.md §10). Returns
// GeoJSON polygons in segment order, plus each corridor's area for sanity
// checks (a corridor's area ≈ 2·w·L + π·w² for width w, length L).

export interface SegmentCorridor {
  seq: number;
  geojson: object;
  areaSqNm: number;
}

function lineWkt(points: [number, number][]): string {
  const coords = points.map(([lon, lat]) => `${lon} ${lat}`).join(",");
  return `LINESTRING(${coords})`;
}

export async function corridorsFor(
  sql: Sql,
  segments: Pick<RouteSegment, "seq" | "points">[],
  widthNm: number,
): Promise<SegmentCorridor[]> {
  if (segments.length === 0) return [];
  const widthM = widthNm * METERS_PER_NM;
  // One plain-parameter query per segment, batched through the pool.
  // Deliberately boring: string + number params only — postgres.js json
  // parameters proved unreliable across its ESM/CJS builds (dual-package
  // serialization bug found during M2), and ~30 tiny indexed queries are
  // fast. Chunked to stay within pool size.
  const out: SegmentCorridor[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (s) => {
        const wkt = lineWkt(s.points);
        const [row] = await sql`
          SELECT
            ST_AsGeoJSON(ST_Buffer(ST_GeogFromText(${wkt}), ${widthM}))::json AS gj,
            ST_Area(ST_Buffer(ST_GeogFromText(${wkt}), ${widthM})) AS area_m2
        `;
        return {
          seq: s.seq,
          geojson: row!.gj as object,
          areaSqNm: Number(row!.area_m2) / (METERS_PER_NM * METERS_PER_NM),
        };
      }),
    );
    out.push(...rows);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
