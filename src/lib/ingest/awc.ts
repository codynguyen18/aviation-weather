import type { Sql } from "postgres";

import type { FetchCoordinator, FetchState } from "@/lib/ingest/coordinator";
import {
  normalizeMetar,
  normalizePirep,
  normalizeTaf,
} from "@/lib/wx/normalize";

// AWC Data API adapters (PLAN.md §7.1). Every fetched product is stored as a
// source_record (provenance) plus normalized rows keyed to it. Idempotent:
// re-fetching the same product is a no-op beyond bumping fetched_at.

export const AWC_BASE = "https://aviationweather.gov/api/data";

export interface IngestResult {
  sourceType: "METAR" | "TAF" | "PIREP";
  state: FetchState; // worst state across the queries made
  fetched: number;   // upstream items seen
  stored: number;    // new normalized rows written
  parseFailures: number;
  errors: string[];
  fetchedAt: string | null;
}

const worst = (a: FetchState, b: FetchState): FetchState => {
  const rank: Record<FetchState, number> = { fresh: 0, "cached-stale": 1, failed: 2 };
  return rank[a] >= rank[b] ? a : b;
};

function parseJsonArray(body: string | undefined): Record<string, unknown>[] {
  if (!body || body.trim() === "") return []; // 204 / empty = no current data
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function upsertSourceRecord(
  sql: Sql,
  row: {
    sourceType: string;
    station: string | null;
    externalKey: string;
    issuedAt: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    upstreamUrl: string;
    raw: unknown;
    parseStatus?: string;
  },
): Promise<{ id: string; inserted: boolean }> {
  const [rec] = await sql`
    INSERT INTO source_records
      (source_type, station, external_key, issued_at, valid_from, valid_to,
       upstream_url, raw, parse_status)
    VALUES
      (${row.sourceType}, ${row.station}, ${row.externalKey}, ${row.issuedAt},
       ${row.validFrom ?? null}, ${row.validTo ?? null}, ${row.upstreamUrl},
       ${JSON.stringify(row.raw)}, ${row.parseStatus ?? "ok"})
    ON CONFLICT (source_type, external_key)
      DO UPDATE SET fetched_at = now()
    RETURNING id, (xmax = 0) AS inserted
  `;
  return { id: rec!.id as string, inserted: Boolean(rec!.inserted) };
}

export interface AwcQueryScope {
  ids?: string[];     // explicit station idents
  bboxes?: string[];  // "minLat,minLon,maxLat,maxLon" chunks along the route
}

export async function ingestMetars(
  sql: Sql,
  coord: FetchCoordinator,
  scope: AwcQueryScope,
  baseUrl = AWC_BASE,
): Promise<IngestResult> {
  const urls: string[] = [];
  if (scope.ids?.length) {
    urls.push(`${baseUrl}/metar?ids=${scope.ids.join(",")}&format=json`);
  }
  for (const b of scope.bboxes ?? []) {
    urls.push(`${baseUrl}/metar?bbox=${b}&format=json`);
  }
  const result: IngestResult = {
    sourceType: "METAR", state: "fresh", fetched: 0, stored: 0,
    parseFailures: 0, errors: [], fetchedAt: null,
  };
  for (const url of urls) {
    const out = await coord.get(url, 60_000);
    result.state = worst(result.state, out.state);
    if (out.state === "failed") {
      result.errors.push(out.error ?? "failed");
      continue;
    }
    result.fetchedAt = out.fetchedAt ?? result.fetchedAt;
    for (const item of parseJsonArray(out.body)) {
      result.fetched += 1;
      const n = normalizeMetar(item);
      if (!n) {
        result.parseFailures += 1;
        await upsertSourceRecord(sql, {
          sourceType: "METAR", station: String(item.icaoId ?? "?"),
          externalKey: `METAR:unparsed:${JSON.stringify(item).slice(0, 120)}`,
          issuedAt: null, upstreamUrl: url, raw: item, parseStatus: "failed",
        });
        continue;
      }
      const rec = await upsertSourceRecord(sql, {
        sourceType: "METAR", station: n.station,
        externalKey: `METAR:${n.station}:${n.observedAt}`,
        issuedAt: n.observedAt, upstreamUrl: url, raw: item,
      });
      if (rec.inserted) {
        await sql`
          INSERT INTO weather_observations
            (source_record_id, station, observed_at, geom, flight_category,
             temp_c, dewpoint_c, wind_dir_deg, wind_speed_kt, wind_gust_kt,
             visibility_sm, ceiling_ft_agl, altim_in_hg, wx_string, clouds,
             missing_fields, raw_text)
          VALUES
            (${rec.id}, ${n.station}, ${n.observedAt},
             ${n.lat !== null && n.lon !== null ? `SRID=4326;POINT(${n.lon} ${n.lat})` : null},
             ${n.flightCategory}, ${n.tempC}, ${n.dewpointC}, ${n.windDirDeg},
             ${n.windSpeedKt}, ${n.windGustKt}, ${n.visibilitySm},
             ${n.ceilingFtAgl}, ${n.altimInHg}, ${n.wxString},
             ${JSON.stringify(n.clouds)}, ${JSON.stringify(n.missingFields)},
             ${n.rawText})
          ON CONFLICT (station, observed_at) DO NOTHING
        `;
        result.stored += 1;
      }
    }
  }
  return result;
}

export async function ingestTafs(
  sql: Sql,
  coord: FetchCoordinator,
  scope: AwcQueryScope,
  baseUrl = AWC_BASE,
): Promise<IngestResult> {
  const urls: string[] = [];
  if (scope.ids?.length) {
    urls.push(`${baseUrl}/taf?ids=${scope.ids.join(",")}&format=json`);
  }
  for (const b of scope.bboxes ?? []) {
    urls.push(`${baseUrl}/taf?bbox=${b}&format=json`);
  }
  const result: IngestResult = {
    sourceType: "TAF", state: "fresh", fetched: 0, stored: 0,
    parseFailures: 0, errors: [], fetchedAt: null,
  };
  for (const url of urls) {
    const out = await coord.get(url, 60_000);
    result.state = worst(result.state, out.state);
    if (out.state === "failed") {
      result.errors.push(out.error ?? "failed");
      continue;
    }
    result.fetchedAt = out.fetchedAt ?? result.fetchedAt;
    for (const item of parseJsonArray(out.body)) {
      result.fetched += 1;
      const groups = normalizeTaf(item);
      if (groups.length === 0) {
        result.parseFailures += 1;
        continue;
      }
      const g0 = groups[0]!;
      const validTo = groups[groups.length - 1]!.validTo;
      const rec = await upsertSourceRecord(sql, {
        sourceType: "TAF", station: g0.station,
        externalKey: `TAF:${g0.station}:${g0.issuedAt}`,
        issuedAt: g0.issuedAt, validFrom: g0.validFrom, validTo,
        upstreamUrl: url, raw: item,
      });
      if (rec.inserted) {
        for (const g of groups) {
          await sql`
            INSERT INTO weather_forecasts
              (source_record_id, station, issued_at, group_seq, group_type,
               probability, valid_from, valid_to, wind_dir_deg, wind_speed_kt,
               wind_gust_kt, visibility_sm, ceiling_ft_agl, wx_string, clouds,
               raw_text)
            VALUES
              (${rec.id}, ${g.station}, ${g.issuedAt}, ${g.groupSeq},
               ${g.groupType}, ${g.probability}, ${g.validFrom}, ${g.validTo},
               ${g.windDirDeg}, ${g.windSpeedKt}, ${g.windGustKt},
               ${g.visibilitySm}, ${g.ceilingFtAgl}, ${g.wxString},
               ${JSON.stringify(g.clouds)}, ${g.rawText})
          `;
        }
        result.stored += 1;
      }
    }
  }
  return result;
}

export async function ingestPireps(
  sql: Sql,
  coord: FetchCoordinator,
  scope: { bboxes: string[]; ageHours?: number },
  baseUrl = AWC_BASE,
): Promise<IngestResult> {
  const age = scope.ageHours ?? 3;
  const result: IngestResult = {
    sourceType: "PIREP", state: "fresh", fetched: 0, stored: 0,
    parseFailures: 0, errors: [], fetchedAt: null,
  };
  for (const b of scope.bboxes) {
    const url = `${baseUrl}/pirep?bbox=${b}&format=json&age=${age}`;
    const out = await coord.get(url, 30_000);
    result.state = worst(result.state, out.state);
    if (out.state === "failed") {
      result.errors.push(out.error ?? "failed");
      continue;
    }
    result.fetchedAt = out.fetchedAt ?? result.fetchedAt;
    for (const item of parseJsonArray(out.body)) {
      result.fetched += 1;
      const n = normalizePirep(item);
      if (!n) {
        result.parseFailures += 1;
        continue;
      }
      // PIREPs have no upstream id; identity = time + place + raw text head.
      const key = `PIREP:${n.observedAt}:${n.lat.toFixed(3)},${n.lon.toFixed(3)}:${n.rawText.slice(0, 60)}`;
      const rec = await upsertSourceRecord(sql, {
        sourceType: "PIREP", station: null, externalKey: key,
        issuedAt: n.observedAt, upstreamUrl: url, raw: item,
      });
      if (rec.inserted) {
        await sql`
          INSERT INTO pireps
            (source_record_id, observed_at, geom, altitude_ft_msl,
             altitude_note, aircraft_type, report_type, urgent, turbulence,
             icing, clouds, wx_string, temp_c, raw_text)
          VALUES
            (${rec.id}, ${n.observedAt},
             ${`SRID=4326;POINT(${n.lon} ${n.lat})`}, ${n.altitudeFtMsl},
             ${n.altitudeNote}, ${n.aircraftType}, ${n.reportType},
             ${n.urgent}, ${JSON.stringify(n.turbulence)},
             ${JSON.stringify(n.icing)}, ${JSON.stringify(n.clouds)},
             ${n.wxString}, ${n.tempC}, ${n.rawText})
        `;
        result.stored += 1;
      }
    }
  }
  return result;
}
