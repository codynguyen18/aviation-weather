import type { Sql } from "postgres";
import { z } from "zod";

import type { FetchCoordinator } from "@/lib/ingest/coordinator";
import { resolveIdent } from "@/lib/nav/resolver";
import { buildRoute, ENGINE_VERSION } from "@/lib/route/engine";
import {
  performanceSchema,
  routeOptionsSchema,
  type RouteModel,
  type RouteSegment,
  type RouteWaypoint,
} from "@/lib/route/types";
import { evaluateSegment, summarizeTrip, type SegmentAssessment } from "@/lib/rules/aggregate";
import {
  aircraftLimitsSchema,
  pilotMinimumsSchema,
  RULESET_VERSION,
  type SegmentContext,
  type StationObservation,
  type ForecastGroup,
  type NearbyPirep,
  type RunwayInfo,
} from "@/lib/rules/types";
import { hazardsForSegment } from "@/lib/wx/intersect";
import { freshnessOf } from "@/lib/wx/freshness";
import { refreshRouteWeather, type RouteWeatherSummary } from "@/lib/wx/service";
import { loadWindField } from "@/lib/wx/winds";
import { METERS_PER_NM } from "@/lib/geo";

// Briefing generation (PLAN.md §5.4): deterministic pipeline from a request
// to an immutable snapshot with full provenance. The LLM (M8) only ever sees
// what this pipeline computed.

// Defensive jsonb read: tolerate legacy double-encoded rows (string scalars).
function parseJsonbArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export const briefingRequestSchema = z.object({
  waypoints: z.array(z.object({
    ident: z.string().min(1).max(40),
    isFuelStop: z.boolean().default(false),
    groundMinutes: z.number().min(0).max(1440).default(45),
  })).min(2).max(30),
  departureTimeUtc: z.string().datetime({ offset: true }),
  dutyStartUtc: z.string().datetime({ offset: true }).nullable().default(null),
  cruiseAltitudeFt: z.number().min(500).max(30000),
  performance: performanceSchema,
  minimums: pilotMinimumsSchema,
  aircraft: aircraftLimitsSchema,
  segmentMaxNm: z.number().min(10).max(200).default(50),
  corridorWidthNm: z.number().min(5).max(60).default(25),
  altitudeBandFt: z.number().min(1000).max(10000).default(4000),
  /** Skip upstream fetches and evaluate against already-stored weather. */
  skipRefresh: z.boolean().default(false),
});
export type BriefingRequest = z.infer<typeof briefingRequestSchema>;

export interface BriefingResult {
  snapshotId: string;
  status: "complete" | "partial";
  partialReasons: string[];
  route: RouteModel;
  assessments: SegmentAssessment[];
  tripSummary: ReturnType<typeof summarizeTrip>;
  refreshSummary: RouteWeatherSummary | null;
  createdAt: string;
}

async function segmentObservations(
  sql: Sql,
  seg: RouteSegment,
  now: Date,
): Promise<StationObservation[]> {
  const wkt = `LINESTRING(${seg.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
  const rows = await sql`
    SELECT DISTINCT ON (o.station)
      o.station, o.observed_at, o.flight_category, o.visibility_sm,
      o.ceiling_ft_agl, o.wind_dir_deg, o.wind_speed_kt, o.wind_gust_kt,
      o.raw_text, o.source_record_id,
      ST_Distance(o.geom, ST_GeogFromText(${wkt})) / ${METERS_PER_NM} AS distance_nm
    FROM weather_observations o
    WHERE o.geom IS NOT NULL
      AND o.observed_at > ${new Date(now.getTime() - 4 * 3_600_000).toISOString()}
      AND ST_DWithin(o.geom, ST_GeogFromText(${wkt}), ${30 * METERS_PER_NM})
    ORDER BY o.station, o.observed_at DESC
  `;
  return rows.map((r) => ({
    station: r.station as string,
    observedAt: new Date(r.observed_at as string).toISOString(),
    flightCategory: (r.flight_category as string | null) ?? null,
    visibilitySm: r.visibility_sm === null ? null : Number(r.visibility_sm),
    ceilingFtAgl: r.ceiling_ft_agl === null ? null : Number(r.ceiling_ft_agl),
    windDirDeg: r.wind_dir_deg === null ? null : Number(r.wind_dir_deg),
    windSpeedKt: r.wind_speed_kt === null ? null : Number(r.wind_speed_kt),
    windGustKt: r.wind_gust_kt === null ? null : Number(r.wind_gust_kt),
    distanceNm: Number(r.distance_nm),
    freshness: freshnessOf("METAR", r.observed_at as string, now),
    sourceRecordId: r.source_record_id as string,
    rawText: r.raw_text as string,
  }));
}

async function segmentForecastGroups(
  sql: Sql,
  seg: RouteSegment,
  terminalAirports: string[],
  now: Date,
): Promise<ForecastGroup[]> {
  if (terminalAirports.length === 0) return [];
  const windowFrom = new Date(Date.parse(seg.time.entryUtc) - 30 * 60_000).toISOString();
  const windowTo = new Date(Date.parse(seg.time.exitUtc) + 30 * 60_000).toISOString();
  const rows = await sql`
    SELECT f.station, f.issued_at, f.group_type, f.probability, f.valid_from,
           f.valid_to, f.visibility_sm, f.ceiling_ft_agl, f.wind_dir_deg,
           f.wind_speed_kt, f.wind_gust_kt, f.wx_string, f.raw_text,
           f.source_record_id
    FROM weather_forecasts f
    WHERE f.station IN ${sql(terminalAirports)}
      AND f.valid_from <= ${windowTo}
      AND f.valid_to >= ${windowFrom}
      AND f.issued_at = (
        SELECT max(f2.issued_at) FROM weather_forecasts f2
        WHERE f2.station = f.station
      )
    ORDER BY f.station, f.group_seq
  `;
  return rows.map((r) => ({
    station: r.station as string,
    issuedAt: new Date(r.issued_at as string).toISOString(),
    groupType: r.group_type as string,
    probability: r.probability === null ? null : Number(r.probability),
    validFrom: new Date(r.valid_from as string).toISOString(),
    validTo: new Date(r.valid_to as string).toISOString(),
    visibilitySm: r.visibility_sm === null ? null : Number(r.visibility_sm),
    ceilingFtAgl: r.ceiling_ft_agl === null ? null : Number(r.ceiling_ft_agl),
    windDirDeg: r.wind_dir_deg === null ? null : Number(r.wind_dir_deg),
    windSpeedKt: r.wind_speed_kt === null ? null : Number(r.wind_speed_kt),
    windGustKt: r.wind_gust_kt === null ? null : Number(r.wind_gust_kt),
    wxString: (r.wx_string as string | null) ?? null,
    freshness: freshnessOf("TAF", r.issued_at as string, now),
    sourceRecordId: r.source_record_id as string,
    rawText: r.raw_text as string,
  }));
}

async function segmentPireps(
  sql: Sql,
  seg: RouteSegment,
  altitudeBandFt: number,
  now: Date,
): Promise<NearbyPirep[]> {
  const wkt = `LINESTRING(${seg.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
  const cutoff = new Date(now.getTime() - 120 * 60_000).toISOString();
  const rows = await sql`
    SELECT p.observed_at, p.altitude_ft_msl, p.aircraft_type, p.urgent,
           p.turbulence, p.icing, p.raw_text, p.source_record_id,
           ST_Distance(p.geom, ST_GeogFromText(${wkt})) / ${METERS_PER_NM} AS distance_nm
    FROM pireps p
    WHERE p.observed_at > ${cutoff}
      AND ST_DWithin(p.geom, ST_GeogFromText(${wkt}), ${50 * METERS_PER_NM})
      AND (p.altitude_ft_msl IS NULL
           OR abs(p.altitude_ft_msl - ${seg.altitudeFt}) <= ${altitudeBandFt})
    ORDER BY p.observed_at DESC
  `;
  return rows.map((r) => ({
    observedAt: new Date(r.observed_at as string).toISOString(),
    distanceNm: Number(r.distance_nm),
    altitudeFtMsl: r.altitude_ft_msl === null ? null : Number(r.altitude_ft_msl),
    aircraftType: (r.aircraft_type as string | null) ?? null,
    urgent: Boolean(r.urgent),
    turbulence: parseJsonbArray(r.turbulence),
    icing: parseJsonbArray(r.icing),
    ageMin: Math.round((now.getTime() - Date.parse(r.observed_at as string)) / 60_000),
    sourceRecordId: r.source_record_id as string,
    rawText: r.raw_text as string,
  }));
}

async function runwaysFor(sql: Sql, airports: string[]): Promise<RunwayInfo[]> {
  if (airports.length === 0) return [];
  const rows = await sql`
    SELECT r.airport_ident, r.le_ident, r.le_heading_deg, r.he_heading_deg
    FROM nav_runways r
    JOIN nav_datasets d ON d.id = r.dataset_id AND d.active
    WHERE r.airport_ident IN ${sql(airports)} AND NOT r.closed
  `;
  const out: RunwayInfo[] = [];
  for (const r of rows) {
    if (r.le_heading_deg !== null) {
      out.push({
        airportIdent: r.airport_ident as string,
        headingDeg: Number(r.le_heading_deg),
        ident: (r.le_ident as string | null) ?? null,
      });
    }
    if (r.he_heading_deg !== null) {
      out.push({
        airportIdent: r.airport_ident as string,
        headingDeg: Number(r.he_heading_deg),
        ident: null,
      });
    }
  }
  return out;
}

export async function generateBriefing(
  sql: Sql,
  coord: FetchCoordinator,
  request: BriefingRequest,
  opts: { awcBaseUrl?: string; nwsBaseUrl?: string; now?: Date; userId?: string | null } = {},
): Promise<BriefingResult> {
  const now = opts.now ?? new Date();

  // 1. Resolve waypoints (fail fast with the full problem list).
  const resolved: RouteWaypoint[] = [];
  for (const w of request.waypoints) {
    const r = await resolveIdent(sql, w.ident);
    if (r.status !== "resolved") {
      throw Object.assign(new Error(`unresolved waypoint ${w.ident}`), {
        code: "UNRESOLVED",
        detail: r,
      });
    }
    resolved.push({ ...r.waypoint, isFuelStop: w.isFuelStop, groundMinutes: w.groundMinutes });
  }
  const routeOpts = routeOptionsSchema.parse(request);

  // 2. Zero-wind pass to know where/when we'll be, then refresh weather.
  const zeroWind = buildRoute(resolved, routeOpts);
  let refreshSummary: RouteWeatherSummary | null = null;
  const partialReasons: string[] = [];
  if (!request.skipRefresh) {
    refreshSummary = await refreshRouteWeather(
      sql, coord, zeroWind, opts.awcBaseUrl, opts.nwsBaseUrl,
    );
    for (const p of refreshSummary.products) {
      if (p.state === "failed") partialReasons.push(`${p.sourceType}: ${p.errors.join("; ") || "failed"}`);
      else if (p.state === "cached-stale") partialReasons.push(`${p.sourceType}: serving cached data (upstream unreachable)`);
    }
  }

  // 3. Wind-adjusted pass with the fresh FB winds.
  const depMs = Date.parse(request.departureTimeUtc);
  const field = await loadWindField(sql, {
    from: new Date(depMs - 3 * 3_600_000),
    to: new Date(depMs + 24 * 3_600_000),
  });
  const route = buildRoute(resolved, routeOpts, field.at);

  const stateOf = (type: string) =>
    refreshSummary?.products.find((p) => p.sourceType === type)?.state ?? "fresh";
  const hazardFeedsOk =
    stateOf("AIRSIGMET") !== "failed" &&
    stateOf("GAIRMET") !== "failed" &&
    stateOf("CWA") !== "failed";

  // 4. Per-segment context + rules.
  const stopIdents = new Set(
    resolved.filter((w) => w.isFuelStop).map((w) => w.ident),
  );
  const first = resolved[0]!.ident;
  const lastIdent = resolved[resolved.length - 1]!.ident;
  const assessments: SegmentAssessment[] = [];
  const usedSourceIds = new Map<string, string>(); // id -> role

  for (const seg of route.segments) {
    const terminalAirports = [
      ...new Set(
        [seg.startIdent, seg.endIdent].filter(
          (id) => id === first || id === lastIdent || stopIdents.has(id),
        ),
      ),
    ];
    const [hazards, observations, forecastGroups, pireps, runways] =
      await Promise.all([
        hazardsForSegment(sql, seg, {
          corridorWidthNm: request.corridorWidthNm,
          altitudeBandFt: request.altitudeBandFt,
          timeBufferMin: 30,
        }),
        segmentObservations(sql, seg, now),
        segmentForecastGroups(sql, seg, terminalAirports, now),
        segmentPireps(sql, seg, request.altitudeBandFt, now),
        runwaysFor(sql, [...new Set([seg.startIdent, seg.endIdent])].filter((id) =>
          [first, lastIdent, ...stopIdents].includes(id),
        )),
      ]);

    const ctx: SegmentContext = {
      segment: seg,
      isFirst: seg.seq === 0,
      isLast: seg.seq === route.segments.length - 1,
      terminalAirports,
      runways,
      minimums: request.minimums,
      aircraft: request.aircraft,
      hazards,
      observations,
      forecastGroups,
      pireps,
      hazardFeedsOk,
      metarFeedOk: stateOf("METAR") !== "failed",
      tafFeedOk: stateOf("TAF") !== "failed",
      pirepFeedOk: stateOf("PIREP") !== "failed",
      dutyStartUtc: request.dutyStartUtc,
      departureTimeUtc: request.departureTimeUtc,
      remainingFlightMinAfterSegment:
        route.totals.airborneMinutes -
        route.segments
          .filter((s) => s.seq <= seg.seq)
          .reduce((a, s) => a + (Date.parse(s.time.exitUtc) - Date.parse(s.time.entryUtc)) / 60_000, 0),
      totalAirborneMin: route.totals.airborneMinutes,
    };
    const assessment = evaluateSegment(ctx);
    assessments.push(assessment);
    for (const e of assessment.evaluations) {
      for (const id of e.sourceRecordIds) usedSourceIds.set(id, e.ruleId);
    }
    if (seg.windSourceRecordId) usedSourceIds.set(seg.windSourceRecordId, "winds-aloft");
  }

  const tripSummary = summarizeTrip(assessments);
  const status = partialReasons.length > 0 ? "partial" : "complete";

  // 5. Persist the immutable snapshot.
  const [snap] = await sql`
    INSERT INTO briefing_snapshots
      (ruleset_version, engine_version, status, partial_reasons, request,
       route, refresh_summary, trip_summary, user_id)
    VALUES
      (${RULESET_VERSION}, ${ENGINE_VERSION}, ${status},
       ${JSON.stringify(partialReasons)}::text::jsonb, ${JSON.stringify(request)}::text::jsonb,
       ${JSON.stringify(route)}::text::jsonb, ${JSON.stringify(refreshSummary ?? {})}::text::jsonb,
       ${JSON.stringify(tripSummary)}::text::jsonb, ${opts.userId ?? null})
    RETURNING id, created_at
  `;
  const snapshotId = snap!.id as string;
  for (const a of assessments) {
    await sql`
      INSERT INTO segment_assessments
        (snapshot_id, segment_seq, rating, confidence, summary, hard_stops)
      VALUES
        (${snapshotId}, ${a.segmentSeq}, ${a.rating}, ${a.confidence},
         ${a.summary}, ${JSON.stringify(a.hardStops)}::text::jsonb)
    `;
    for (const e of a.evaluations) {
      await sql`
        INSERT INTO rule_evaluations
          (snapshot_id, segment_seq, rule_id, rule_version, rule_class,
           result, measured, thresholds, confidence, explanation,
           is_hard_stop, source_record_ids)
        VALUES
          (${snapshotId}, ${a.segmentSeq}, ${e.ruleId}, ${e.ruleVersion},
           ${e.ruleClass}, ${e.result}, ${JSON.stringify(e.measured)}::text::jsonb,
           ${JSON.stringify(e.thresholds)}::text::jsonb, ${e.confidence}, ${e.explanation},
           ${e.isHardStop}, ${JSON.stringify(e.sourceRecordIds)}::text::jsonb)
      `;
    }
  }
  for (const [id, role] of usedSourceIds) {
    await sql`
      INSERT INTO briefing_source_links (snapshot_id, source_record_id, role)
      VALUES (${snapshotId}, ${id}, ${role})
      ON CONFLICT DO NOTHING
    `;
  }

  return {
    snapshotId,
    status,
    partialReasons,
    route,
    assessments,
    tripSummary,
    refreshSummary,
    createdAt: new Date(snap!.created_at as string).toISOString(),
  };
}
