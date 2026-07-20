import type { Sql } from "postgres";

import { METERS_PER_NM } from "@/lib/geo";
import type { RouteSegment } from "@/lib/route/types";

// Hazard x corridor intersection (PLAN.md §8.6): a hazard attaches to a
// segment only when it passes ALL THREE gates — spatial (corridor buffer),
// temporal (validity overlaps the segment's ETA window +/- buffer), and
// vertical (floor/ceiling overlaps the altitude band). NULL floor = surface,
// NULL ceiling = unlimited (conservative on both ends).

export interface HazardHit {
  hazardId: string;
  sourceRecordId: string;
  product: string;
  hazard: string;
  severity: string | null;
  qualifier: string | null;
  floorFtMsl: number | null;
  ceilingFtMsl: number | null;
  validFrom: string;
  validTo: string;
  clipNm: number; // how much of the segment corridor the hazard clips
  clipGeojson: object | null;
  rawText: string | null;
}

export async function hazardsForSegment(
  sql: Sql,
  seg: Pick<RouteSegment, "points" | "altitudeFt" | "time">,
  opts: {
    corridorWidthNm: number;
    altitudeBandFt: number;
    timeBufferMin: number;
  },
): Promise<HazardHit[]> {
  const wkt = `LINESTRING(${seg.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
  const widthM = opts.corridorWidthNm * METERS_PER_NM;
  const windowFrom = new Date(
    Date.parse(seg.time.entryUtc) - opts.timeBufferMin * 60_000,
  ).toISOString();
  const windowTo = new Date(
    Date.parse(seg.time.exitUtc) + opts.timeBufferMin * 60_000,
  ).toISOString();
  const bandFloor = seg.altitudeFt - opts.altitudeBandFt;
  const bandCeiling = seg.altitudeFt + opts.altitudeBandFt;

  const rows = await sql`
    SELECT h.id, h.source_record_id, h.product, h.hazard, h.severity,
           h.qualifier, h.floor_ft_msl, h.ceiling_ft_msl,
           h.valid_from, h.valid_to, h.raw_text,
           -- clip = how much of the segment CENTERLINE lies inside the hazard
           -- (may be 0 when the hazard only clips the corridor's edge)
           ST_Length(ST_Intersection(h.geom, ST_GeogFromText(${wkt})))
             / ${METERS_PER_NM} AS clip_nm,
           ST_AsGeoJSON(ST_Intersection(h.geom,
             ST_Buffer(ST_GeogFromText(${wkt}), ${widthM})))::json AS clip_gj
    FROM hazard_geometries h
    WHERE h.valid_to >= ${windowFrom}
      AND h.valid_from <= ${windowTo}
      AND (h.floor_ft_msl IS NULL OR h.floor_ft_msl <= ${bandCeiling})
      AND (h.ceiling_ft_msl IS NULL OR h.ceiling_ft_msl >= ${bandFloor})
      AND ST_Intersects(h.geom, ST_Buffer(ST_GeogFromText(${wkt}), ${widthM}))
  `;
  return rows.map((r) => ({
    hazardId: r.id as string,
    sourceRecordId: r.source_record_id as string,
    product: r.product as string,
    hazard: r.hazard as string,
    severity: (r.severity as string | null) ?? null,
    qualifier: (r.qualifier as string | null) ?? null,
    floorFtMsl: r.floor_ft_msl === null ? null : Number(r.floor_ft_msl),
    ceilingFtMsl: r.ceiling_ft_msl === null ? null : Number(r.ceiling_ft_msl),
    validFrom: new Date(r.valid_from as string).toISOString(),
    validTo: new Date(r.valid_to as string).toISOString(),
    clipNm: Number(r.clip_nm),
    clipGeojson: (r.clip_gj as object | null) ?? null,
    rawText: (r.raw_text as string | null) ?? null,
  }));
}

export interface NearbyHazard {
  hazardId: string;
  sourceRecordId: string;
  product: string;
  hazard: string;
  severity: string | null;
  floorFtMsl: number | null;
  ceilingFtMsl: number | null;
  validFrom: string;
  validTo: string;
  rawText: string | null;
  station: string | null;
  geometry: object | null; // full hazard shape (GeoJSON), not clipped
}

/**
 * Every hazard whose full shape falls within the route's bounding box (plus a
 * margin) and whose validity is anywhere near the flight window. This is what
 * the map draws: it shows hazards *near* the route — including ones that don't
 * clip the corridor or that expired shortly before departure — so the pilot
 * can see and click the surrounding weather, not just what changed the rating.
 */
export async function hazardsNearRoute(
  sql: Sql,
  route: {
    segments: { points: [number, number][] }[];
    totals: { departureUtc: string; arrivalUtc: string };
  },
  opts: { marginDeg?: number; windowPadMin?: number } = {},
): Promise<NearbyHazard[]> {
  const margin = opts.marginDeg ?? 1.0;
  const pad = opts.windowPadMin ?? 180;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const s of route.segments) {
    for (const [lon, lat] of s.points) {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    }
  }
  if (!Number.isFinite(minLat)) return [];
  const windowFrom = new Date(Date.parse(route.totals.departureUtc) - pad * 60_000).toISOString();
  const windowTo = new Date(Date.parse(route.totals.arrivalUtc) + pad * 60_000).toISOString();

  const rows = await sql`
    SELECT h.id, h.source_record_id, h.product, h.hazard, h.severity,
           h.floor_ft_msl, h.ceiling_ft_msl, h.valid_from, h.valid_to,
           h.raw_text, s.station,
           ST_AsGeoJSON(h.geom)::json AS geom
    FROM hazard_geometries h
    JOIN source_records s ON s.id = h.source_record_id
    WHERE h.valid_to >= ${windowFrom} AND h.valid_from <= ${windowTo}
      AND ST_Intersects(
        h.geom,
        ST_MakeEnvelope(${minLon - margin}, ${minLat - margin},
                        ${maxLon + margin}, ${maxLat + margin}, 4326)::geography
      )
    ORDER BY h.product, h.valid_to
  `;
  return rows.map((r) => ({
    hazardId: r.id as string,
    sourceRecordId: r.source_record_id as string,
    product: r.product as string,
    hazard: r.hazard as string,
    severity: (r.severity as string | null) ?? null,
    floorFtMsl: r.floor_ft_msl === null ? null : Number(r.floor_ft_msl),
    ceilingFtMsl: r.ceiling_ft_msl === null ? null : Number(r.ceiling_ft_msl),
    validFrom: new Date(r.valid_from as string).toISOString(),
    validTo: new Date(r.valid_to as string).toISOString(),
    rawText: (r.raw_text as string | null) ?? null,
    station: (r.station as string | null) ?? null,
    geometry: (r.geom as object | null) ?? null,
  }));
}
