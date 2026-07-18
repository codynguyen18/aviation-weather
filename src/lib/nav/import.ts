import type { Sql } from "postgres";

import {
  parseAirportsCsv,
  parseNavaidsCsv,
  parseRunwaysCsv,
} from "@/lib/nav/ourairports";

export interface ImportInput {
  airportsCsv: string;
  runwaysCsv: string;
  navaidsCsv: string;
  versionLabel: string;
  /**
   * Prune datasets older than the one inactive predecessor (default true for
   * production refreshes). Tests MUST pass false: their throwaway imports
   * would otherwise count as "newer cycles" and delete the real dataset.
   */
  prune?: boolean;
}

export interface ImportResult {
  datasetId: string;
  airports: number;
  runways: number;
  navaids: number;
}

const CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Loads a complete OurAirports snapshot as a NEW dataset, then atomically
// deactivates the old one and activates the new one. Readers always see
// exactly one complete 'ourairports' dataset. Prior datasets beyond the most
// recent inactive one are deleted (cascades to their rows).
export async function importOurAirports(
  sql: Sql,
  input: ImportInput,
): Promise<ImportResult> {
  const airports = parseAirportsCsv(input.airportsCsv);
  const runways = parseRunwaysCsv(input.runwaysCsv);
  const navaids = parseNavaidsCsv(input.navaidsCsv);

  if (airports.length === 0) {
    throw new Error("refusing to import: zero airports parsed");
  }

  const [dataset] = await sql`
    INSERT INTO nav_datasets (source, version_label)
    VALUES ('ourairports', ${input.versionLabel})
    RETURNING id
  `;
  const datasetId = dataset!.id as string;

  for (const batch of chunks(airports, CHUNK)) {
    const rows = batch.map((a) => ({
      dataset_id: datasetId,
      ident: a.ident,
      icao_code: a.icaoCode,
      iata_code: a.iataCode,
      gps_code: a.gpsCode,
      local_code: a.localCode,
      name: a.name,
      type: a.type,
      geom: `SRID=4326;POINT(${a.lon} ${a.lat})`,
      elevation_ft: a.elevationFt,
      municipality: a.municipality,
      iso_region: a.isoRegion,
      iso_country: a.isoCountry,
      scheduled_service: a.scheduledService,
    }));
    await sql`INSERT INTO nav_airports ${sql(rows)}`;
  }

  for (const batch of chunks(runways, CHUNK)) {
    const rows = batch.map((r) => ({
      dataset_id: datasetId,
      airport_ident: r.airportIdent,
      le_ident: r.leIdent,
      he_ident: r.heIdent,
      length_ft: r.lengthFt,
      width_ft: r.widthFt,
      surface: r.surface,
      lighted: r.lighted,
      closed: r.closed,
      le_heading_deg: r.leHeadingDeg,
      he_heading_deg: r.heHeadingDeg,
    }));
    await sql`INSERT INTO nav_runways ${sql(rows)}`;
  }

  for (const batch of chunks(navaids, CHUNK)) {
    const rows = batch.map((n) => ({
      dataset_id: datasetId,
      ident: n.ident,
      name: n.name,
      type: n.type,
      frequency_khz: n.frequencyKhz,
      geom: `SRID=4326;POINT(${n.lon} ${n.lat})`,
      elevation_ft: n.elevationFt,
      iso_country: n.isoCountry,
      magnetic_variation_deg: n.magneticVariationDeg,
      usage_type: n.usageType,
      associated_airport: n.associatedAirport,
    }));
    await sql`INSERT INTO nav_navaids ${sql(rows)}`;
  }

  await sql.begin(async (tx) => {
    await tx`UPDATE nav_datasets SET active = false
             WHERE source = 'ourairports' AND active`;
    await tx`UPDATE nav_datasets SET active = true WHERE id = ${datasetId}`;
    if (input.prune !== false) {
      // Keep exactly one inactive predecessor for rollback; drop older ones.
      await tx`
        DELETE FROM nav_datasets
        WHERE source = 'ourairports' AND NOT active AND id NOT IN (
          SELECT id FROM nav_datasets
          WHERE source = 'ourairports' AND NOT active
          ORDER BY imported_at DESC LIMIT 1
        )
      `;
    }
  });

  return {
    datasetId,
    airports: airports.length,
    runways: runways.length,
    navaids: navaids.length,
  };
}
