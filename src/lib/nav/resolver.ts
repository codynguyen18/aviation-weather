import type { Sql } from "postgres";
import { z } from "zod";

// Waypoint resolution (PLAN.md §8.2): deterministic lookup against the active
// navdata snapshot. Never silently guesses — ambiguous input returns the
// candidates for the pilot to choose from.

export const waypointSchema = z.object({
  kind: z.enum(["airport", "navaid", "latlon"]),
  ident: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  elevationFt: z.number().nullable(),
  type: z.string(),
  isoCountry: z.string().nullable(),
  municipality: z.string().nullable(),
  navSource: z.string(), // e.g. "ourairports@2026-07-18"
});
export type Waypoint = z.infer<typeof waypointSchema>;

export type ResolveResult =
  | { status: "resolved"; waypoint: Waypoint }
  | { status: "ambiguous"; candidates: Waypoint[] }
  | { status: "not-found" };

// "38.75,-90.37" (optionally with spaces) -> lat/lon waypoint
const LATLON_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function parseLatLon(q: string): { lat: number; lon: number } | null {
  const m = LATLON_RE.exec(q);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const IDENT_RE = /^[A-Z0-9]{2,7}$/;

interface ActiveDataset {
  id: string;
  label: string;
}

async function activeDataset(sql: Sql): Promise<ActiveDataset | null> {
  const rows = await sql`
    SELECT id, source || '@' || version_label AS label
    FROM nav_datasets WHERE source = 'ourairports' AND active
  `;
  const row = rows[0];
  return row ? { id: row.id as string, label: row.label as string } : null;
}

interface AirportHit {
  ident: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation_ft: number | null;
  iso_country: string;
  municipality: string | null;
  scheduled_service: boolean;
  priority: number;
}

export async function resolveIdent(
  sql: Sql,
  rawQuery: string,
): Promise<ResolveResult> {
  const latlon = parseLatLon(rawQuery);
  if (latlon) {
    return {
      status: "resolved",
      waypoint: {
        kind: "latlon",
        ident: `${latlon.lat.toFixed(4)},${latlon.lon.toFixed(4)}`,
        name: "Coordinates",
        lat: latlon.lat,
        lon: latlon.lon,
        elevationFt: null,
        type: "latlon",
        isoCountry: null,
        municipality: null,
        navSource: "user-input",
      },
    };
  }

  const q = rawQuery.trim().toUpperCase();
  if (!IDENT_RE.test(q)) return { status: "not-found" };

  const ds = await activeDataset(sql);
  if (!ds) {
    throw new Error("no active navdata dataset — run the navdata import");
  }

  // Priority: exact ident/ICAO (1) > gps/local code (2) > IATA (3).
  // One airport can match on several columns; keep its best priority.
  const airports = (await sql`
    SELECT ident, name, type,
           ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
           elevation_ft, iso_country, municipality, scheduled_service,
           min(priority) AS priority
    FROM (
      SELECT *, 1 AS priority FROM nav_airports
        WHERE dataset_id = ${ds.id} AND (ident = ${q} OR icao_code = ${q})
      UNION ALL
      SELECT *, 2 AS priority FROM nav_airports
        WHERE dataset_id = ${ds.id} AND (gps_code = ${q} OR local_code = ${q})
      UNION ALL
      SELECT *, 3 AS priority FROM nav_airports
        WHERE dataset_id = ${ds.id} AND iata_code = ${q}
    ) hits
    GROUP BY ident, name, type, geom, elevation_ft, iso_country,
             municipality, scheduled_service
  `) as unknown as AirportHit[];

  const navaids = await sql`
    SELECT ident, name, type,
           ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
           elevation_ft, iso_country
    FROM nav_navaids
    WHERE dataset_id = ${ds.id} AND ident = ${q}
  `;

  const toAirportWp = (a: AirportHit): Waypoint => ({
    kind: "airport",
    ident: a.ident,
    name: a.name,
    lat: Number(a.lat),
    lon: Number(a.lon),
    elevationFt: a.elevation_ft,
    type: a.type,
    isoCountry: a.iso_country,
    municipality: a.municipality,
    navSource: ds.label,
  });

  const navaidWps: Waypoint[] = navaids.map((n) => ({
    kind: "navaid" as const,
    ident: n.ident as string,
    name: `${n.name} ${n.type}`,
    lat: Number(n.lat),
    lon: Number(n.lon),
    elevationFt: (n.elevation_ft as number | null) ?? null,
    type: n.type as string,
    isoCountry: (n.iso_country as string | null) ?? null,
    municipality: null,
    navSource: ds.label,
  }));

  // An exact ident/ICAO airport match outranks everything else: "KSTL" must
  // resolve directly even though the STL VORTAC exists.
  const exact = airports.filter((a) => a.priority === 1);
  if (exact.length === 1 && exact[0]) {
    return { status: "resolved", waypoint: toAirportWp(exact[0]) };
  }

  const candidates: Waypoint[] = [
    ...airports
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          Number(b.scheduled_service) - Number(a.scheduled_service) ||
          Number(b.iso_country === "US") - Number(a.iso_country === "US"),
      )
      .map(toAirportWp),
    ...navaidWps,
  ];

  if (candidates.length === 0) return { status: "not-found" };
  if (candidates.length === 1 && candidates[0]) {
    return { status: "resolved", waypoint: candidates[0] };
  }
  return { status: "ambiguous", candidates };
}

export interface NearbyAirport {
  ident: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  distanceNm: number;
  longestRunwayFt: number | null;
  longestRunwaySurface: string | null;
  lighted: boolean;
}

// Airports within `radiusNm` of a point — the query behind diversion-airport
// candidates (PLAN.md §8.4). Excludes closed airports, heliports, and
// seaplane bases; balloonports don't help a Bonanza either.
export async function airportsNear(
  sql: Sql,
  lat: number,
  lon: number,
  radiusNm: number,
  limit = 25,
): Promise<NearbyAirport[]> {
  const ds = await activeDataset(sql);
  if (!ds) {
    throw new Error("no active navdata dataset — run the navdata import");
  }
  const meters = radiusNm * 1852;
  const rows = await sql`
    SELECT a.ident, a.name, a.type,
           ST_Y(a.geom::geometry) AS lat, ST_X(a.geom::geometry) AS lon,
           a.elevation_ft,
           ST_Distance(a.geom,
             ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography
           ) / 1852.0 AS distance_nm,
           r.length_ft AS longest_runway_ft,
           r.surface AS longest_runway_surface,
           COALESCE(r.lighted, false) AS lighted
    FROM nav_airports a
    LEFT JOIN LATERAL (
      SELECT length_ft, surface, lighted
      FROM nav_runways
      WHERE dataset_id = a.dataset_id AND airport_ident = a.ident
        AND NOT closed
      ORDER BY length_ft DESC NULLS LAST
      LIMIT 1
    ) r ON true
    WHERE a.dataset_id = ${ds.id}
      AND a.type IN ('large_airport', 'medium_airport', 'small_airport')
      AND ST_DWithin(a.geom,
            ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
            ${meters})
    ORDER BY distance_nm
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    ident: r.ident as string,
    name: r.name as string,
    type: r.type as string,
    lat: Number(r.lat),
    lon: Number(r.lon),
    elevationFt: (r.elevation_ft as number | null) ?? null,
    distanceNm: Number(r.distance_nm),
    longestRunwayFt: (r.longest_runway_ft as number | null) ?? null,
    longestRunwaySurface: (r.longest_runway_surface as string | null) ?? null,
    lighted: Boolean(r.lighted),
  }));
}

// Typeahead for the New Flight Plan screen: prefix match on any code column
// or name, big scheduled-service fields first.
export async function searchWaypoints(
  sql: Sql,
  rawQuery: string,
  limit = 10,
): Promise<Waypoint[]> {
  const ds = await activeDataset(sql);
  if (!ds) return [];
  const q = rawQuery.trim().toUpperCase();
  if (q.length < 2) return [];
  const prefix = q + "%";
  const namePrefix = rawQuery.trim().toLowerCase() + "%";
  const rows = await sql`
    SELECT ident, name, type,
           ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon,
           elevation_ft, iso_country, municipality, scheduled_service
    FROM nav_airports
    WHERE dataset_id = ${ds.id}
      AND type <> 'closed'
      AND (ident LIKE ${prefix} OR icao_code LIKE ${prefix}
           OR gps_code LIKE ${prefix} OR local_code LIKE ${prefix}
           OR iata_code LIKE ${prefix} OR lower(name) LIKE ${namePrefix})
    ORDER BY scheduled_service DESC,
             CASE type WHEN 'large_airport' THEN 0
                       WHEN 'medium_airport' THEN 1
                       WHEN 'small_airport' THEN 2 ELSE 3 END,
             ident
    LIMIT ${limit}
  `;
  return rows.map((a) => ({
    kind: "airport" as const,
    ident: a.ident as string,
    name: a.name as string,
    lat: Number(a.lat),
    lon: Number(a.lon),
    elevationFt: (a.elevation_ft as number | null) ?? null,
    type: a.type as string,
    isoCountry: (a.iso_country as string | null) ?? null,
    municipality: (a.municipality as string | null) ?? null,
    navSource: ds.label,
  }));
}
