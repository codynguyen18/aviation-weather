import type { Sql } from "postgres";

import type { FetchCoordinator } from "@/lib/ingest/coordinator";
import {
  ingestMetars,
  ingestPireps,
  ingestTafs,
  type IngestResult,
} from "@/lib/ingest/awc";
import {
  ingestAfds,
  ingestHazardProduct,
  ingestWindtemp,
  type HazardIngestResult,
} from "@/lib/ingest/hazards";
import type { RouteModel } from "@/lib/route/types";

// Route-scoped weather refresh (M3: METAR/TAF/PIREP; hazards & winds in M4).
// Queries are chunked into bounding boxes along the route so upstream calls
// stay small and shareable between overlapping routes.

/** Split the route polyline into padded bbox strings (AWC order: minLat,minLon,maxLat,maxLon). */
export function routeBboxes(model: RouteModel, chunkNm = 350, padDeg = 0.7): string[] {
  const boxes: string[] = [];
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let accumulated = 0;
  const flush = () => {
    if (minLat === Infinity) return;
    boxes.push(
      `${(minLat - padDeg).toFixed(2)},${(minLon - padDeg).toFixed(2)},${(maxLat + padDeg).toFixed(2)},${(maxLon + padDeg).toFixed(2)}`,
    );
    minLat = Infinity; maxLat = -Infinity; minLon = Infinity; maxLon = -Infinity;
  };
  for (const seg of model.segments) {
    for (const [lon, lat] of seg.points) {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    }
    accumulated += seg.distanceNm;
    if (accumulated >= chunkNm) {
      flush();
      accumulated = 0;
    }
  }
  flush();
  return boxes;
}

export interface RouteWeatherSummary {
  products: (IngestResult | HazardIngestResult)[];
  refreshedAt: string;
}

/** Sample points for WFO (AFD office) resolution: endpoints + ~every 250 nm. */
export function afdSamplePoints(model: RouteModel): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = [];
  let sinceLast = Infinity;
  for (const seg of model.segments) {
    if (sinceLast >= 250) {
      pts.push({ lat: seg.startLat, lon: seg.startLon });
      sinceLast = 0;
    }
    sinceLast += seg.distanceNm;
  }
  const last = model.segments[model.segments.length - 1];
  if (last) pts.push({ lat: last.endLat, lon: last.endLon });
  return pts;
}

export async function refreshRouteWeather(
  sql: Sql,
  coord: FetchCoordinator,
  model: RouteModel,
  baseUrl?: string,
  nwsBaseUrl?: string,
): Promise<RouteWeatherSummary> {
  const bboxes = routeBboxes(model);
  const ids = model.waypoints
    .map((w) => w.ident)
    .filter((id) => /^[A-Z0-9]{3,4}$/.test(id));

  // Sources are independent: one failing must not block the others.
  const [metars, tafs, pireps, airsigmets, gairmets, cwas, winds, afds] =
    await Promise.all([
      ingestMetars(sql, coord, { ids, bboxes }, baseUrl),
      ingestTafs(sql, coord, { ids, bboxes }, baseUrl),
      ingestPireps(sql, coord, { bboxes }, baseUrl),
      ingestHazardProduct(sql, coord, "airsigmet", baseUrl),
      ingestHazardProduct(sql, coord, "gairmet", baseUrl),
      ingestHazardProduct(sql, coord, "cwa", baseUrl),
      ingestWindtemp(sql, coord, ["06", "12", "24"], baseUrl),
      ingestAfds(sql, coord, afdSamplePoints(model), nwsBaseUrl),
    ]);

  return {
    products: [metars, tafs, pireps, airsigmets, gairmets, cwas, winds, afds],
    refreshedAt: new Date().toISOString(),
  };
}
