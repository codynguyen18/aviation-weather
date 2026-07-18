import type { Sql } from "postgres";

import { AWC_BASE } from "@/lib/ingest/awc";
import type { FetchCoordinator, FetchState } from "@/lib/ingest/coordinator";
import {
  normalizeAirsigmet,
  normalizeCwa,
  normalizeGairmet,
  type NormalizedHazard,
} from "@/lib/wx/normalize-hazard";
import { parseWindTemp } from "@/lib/wx/windtemp";

export const NWS_BASE = "https://api.weather.gov";

export interface HazardIngestResult {
  sourceType: "AIRSIGMET" | "GAIRMET" | "CWA" | "WINDTEMP" | "AFD";
  state: FetchState;
  fetched: number;
  stored: number;
  errors: string[];
  fetchedAt: string | null;
}

async function storeHazard(
  sql: Sql,
  n: NormalizedHazard,
  sourceType: string,
  url: string,
  rawFeature: unknown,
): Promise<boolean> {
  const [rec] = await sql`
    INSERT INTO source_records
      (source_type, station, external_key, issued_at, valid_from, valid_to,
       upstream_url, raw)
    VALUES
      (${sourceType}, null, ${n.externalKey}, ${n.validFrom}, ${n.validFrom},
       ${n.validTo}, ${url}, ${JSON.stringify(rawFeature)})
    ON CONFLICT (source_type, external_key) DO UPDATE SET fetched_at = now()
    RETURNING id, (xmax = 0) AS inserted
  `;
  if (!rec!.inserted) return false;
  await sql`
    INSERT INTO hazard_geometries
      (source_record_id, product, hazard, severity, qualifier, geom,
       floor_ft_msl, ceiling_ft_msl, movement_dir_deg, movement_spd_kt,
       forecast_hour, valid_from, valid_to, raw_text)
    VALUES
      (${rec!.id}, ${n.product}, ${n.hazard}, ${n.severity}, ${n.qualifier},
       ST_GeomFromGeoJSON(${JSON.stringify(n.geometry)})::geography,
       ${n.floorFtMsl}, ${n.ceilingFtMsl}, ${n.movementDirDeg},
       ${n.movementSpdKt}, ${n.forecastHour}, ${n.validFrom}, ${n.validTo},
       ${n.rawText})
  `;
  return true;
}

type FeatureCollection = { features?: unknown[] };

function features(body: string | undefined): Record<string, unknown>[] {
  if (!body || body.trim() === "") return [];
  try {
    const fc = JSON.parse(body) as FeatureCollection;
    return (fc.features ?? []) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export async function ingestHazardProduct(
  sql: Sql,
  coord: FetchCoordinator,
  product: "airsigmet" | "gairmet" | "cwa",
  baseUrl = AWC_BASE,
): Promise<HazardIngestResult> {
  const sourceType = product.toUpperCase() as "AIRSIGMET" | "GAIRMET" | "CWA";
  const url = `${baseUrl}/${product}?format=geojson`;
  const ttl = product === "airsigmet" ? 120_000 : 60_000;
  const out = await coord.get(url, ttl);
  const result: HazardIngestResult = {
    sourceType, state: out.state, fetched: 0, stored: 0,
    errors: out.error ? [out.error] : [], fetchedAt: out.fetchedAt ?? null,
  };
  if (out.state === "failed") return result;
  const normalize =
    product === "airsigmet" ? normalizeAirsigmet
    : product === "gairmet" ? normalizeGairmet
    : normalizeCwa;
  for (const f of features(out.body)) {
    result.fetched += 1;
    const n = normalize(f as never);
    if (!n) continue;
    if (await storeHazard(sql, n, sourceType, url, f)) result.stored += 1;
  }
  return result;
}

export async function ingestWindtemp(
  sql: Sql,
  coord: FetchCoordinator,
  fcsts: ("06" | "12" | "24")[] = ["06", "12", "24"],
  baseUrl = AWC_BASE,
  referenceDate = new Date(),
): Promise<HazardIngestResult> {
  const result: HazardIngestResult = {
    sourceType: "WINDTEMP", state: "fresh", fetched: 0, stored: 0,
    errors: [], fetchedAt: null,
  };
  for (const fcst of fcsts) {
    const url = `${baseUrl}/windtemp?region=us&level=low&fcst=${fcst}`;
    const out = await coord.get(url, 180_000);
    if (out.state === "failed") {
      result.state = "failed";
      result.errors.push(out.error ?? `fcst ${fcst} failed`);
      continue;
    }
    result.fetchedAt = out.fetchedAt ?? result.fetchedAt;
    const bulletin = parseWindTemp(out.body ?? "", referenceDate);
    if (!bulletin) {
      result.errors.push(`fcst ${fcst}: unparseable bulletin`);
      continue;
    }
    result.fetched += bulletin.entries.length;
    const [rec] = await sql`
      INSERT INTO source_records
        (source_type, station, external_key, issued_at, valid_from, valid_to,
         upstream_url, raw)
      VALUES
        ('WINDTEMP', ${"us-low-" + fcst},
         ${`WINDTEMP:us:low:${fcst}:${bulletin.basedOn}`},
         ${bulletin.basedOn}, ${bulletin.forUseFrom}, ${bulletin.forUseTo},
         ${url}, ${JSON.stringify({ text: out.body })})
      ON CONFLICT (source_type, external_key) DO UPDATE SET fetched_at = now()
      RETURNING id, (xmax = 0) AS inserted
    `;
    if (rec!.inserted) {
      for (const e of bulletin.entries) {
        await sql`
          INSERT INTO winds_aloft
            (source_record_id, region, level_class, fcst, based_on,
             for_use_from, for_use_to, station, level_ft, wind_dir_deg,
             wind_speed_kt, temp_c, light_variable)
          VALUES
            (${rec!.id}, 'us', 'low', ${fcst}, ${bulletin.basedOn},
             ${bulletin.forUseFrom}, ${bulletin.forUseTo}, ${e.station},
             ${e.levelFt}, ${e.windDirDeg}, ${e.windSpeedKt}, ${e.tempC},
             ${e.lightVariable})
          ON CONFLICT (source_record_id, station, level_ft) DO NOTHING
        `;
      }
      result.stored += bulletin.entries.length;
    }
  }
  return result;
}

/** Resolve the WFO (forecast office) for sampled route points, then pull
 *  each office's latest Area Forecast Discussion. Untrusted text — stored
 *  verbatim, never parsed into instructions (PLAN.md §12.4). */
export async function ingestAfds(
  sql: Sql,
  coord: FetchCoordinator,
  samplePoints: { lat: number; lon: number }[],
  baseUrl = NWS_BASE,
): Promise<HazardIngestResult> {
  const result: HazardIngestResult = {
    sourceType: "AFD", state: "fresh", fetched: 0, stored: 0,
    errors: [], fetchedAt: null,
  };
  const offices = new Set<string>();
  for (const pt of samplePoints) {
    const url = `${baseUrl}/points/${pt.lat.toFixed(3)},${pt.lon.toFixed(3)}`;
    const out = await coord.get(url, 86_400_000); // point->office mapping ~static
    if (out.state === "failed") {
      result.state = "cached-stale";
      result.errors.push(`points ${pt.lat},${pt.lon}: ${out.error}`);
      continue;
    }
    try {
      const parsed = JSON.parse(out.body ?? "{}") as {
        properties?: { gridId?: string };
      };
      if (parsed.properties?.gridId) offices.add(parsed.properties.gridId);
    } catch {
      result.errors.push(`points ${pt.lat},${pt.lon}: parse error`);
    }
  }
  for (const wfo of offices) {
    const url = `${baseUrl}/products/types/AFD/locations/${wfo}/latest`;
    const out = await coord.get(url, 120_000);
    if (out.state === "failed") {
      result.state = "failed";
      result.errors.push(`AFD ${wfo}: ${out.error}`);
      continue;
    }
    result.fetchedAt = out.fetchedAt ?? result.fetchedAt;
    try {
      const p = JSON.parse(out.body ?? "{}") as Record<string, unknown>;
      const issuanceTime = typeof p.issuanceTime === "string" ? p.issuanceTime : null;
      const productText = typeof p.productText === "string" ? p.productText : null;
      if (!issuanceTime || !productText) continue;
      result.fetched += 1;
      const [rec] = await sql`
        INSERT INTO source_records
          (source_type, station, external_key, issued_at, upstream_url, raw)
        VALUES
          ('AFD', ${wfo}, ${`AFD:${wfo}:${issuanceTime}`}, ${issuanceTime},
           ${url}, ${JSON.stringify({ issuingOffice: p.issuingOffice, issuanceTime, text: productText })})
        ON CONFLICT (source_type, external_key) DO UPDATE SET fetched_at = now()
        RETURNING (xmax = 0) AS inserted
      `;
      if (rec!.inserted) result.stored += 1;
    } catch {
      result.errors.push(`AFD ${wfo}: parse error`);
    }
  }
  return result;
}
