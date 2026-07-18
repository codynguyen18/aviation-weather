import { parse } from "csv-parse/sync";
import { z } from "zod";

// Parsers for OurAirports CSV dumps (public domain, daily refresh).
// Quirks handled here, verified against the live files (PLAN.md §7.6):
// - empty strings for missing values (elevation, codes) -> null
// - US small fields often have gps_code/local_code but NO icao_code (KO22)
// - scheduled_service is "yes"/"no"; runway lighted/closed are "1"/"0"
// - rows without coordinates are unusable for routing and are skipped

const emptyToNull = (v: string) => (v.trim() === "" ? null : v.trim());

const numOrNull = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export interface AirportRow {
  ident: string;
  icaoCode: string | null;
  iataCode: string | null;
  gpsCode: string | null;
  localCode: string | null;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  municipality: string | null;
  isoRegion: string | null;
  isoCountry: string;
  scheduledService: boolean;
}

export interface RunwayRow {
  airportIdent: string;
  leIdent: string | null;
  heIdent: string | null;
  lengthFt: number | null;
  widthFt: number | null;
  surface: string | null;
  lighted: boolean;
  closed: boolean;
  leHeadingDeg: number | null;
  heHeadingDeg: number | null;
}

export interface NavaidRow {
  ident: string;
  name: string;
  type: string;
  frequencyKhz: number | null;
  lat: number;
  lon: number;
  elevationFt: number | null;
  isoCountry: string | null;
  magneticVariationDeg: number | null;
  usageType: string | null;
  associatedAirport: string | null;
}

const csvRecord = z.record(z.string(), z.string());

function parseCsv(content: string): Record<string, string>[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as unknown[];
  return rows.map((r) => csvRecord.parse(r));
}

export function parseAirportsCsv(content: string): AirportRow[] {
  const out: AirportRow[] = [];
  for (const r of parseCsv(content)) {
    const lat = numOrNull(r.latitude_deg ?? "");
    const lon = numOrNull(r.longitude_deg ?? "");
    const ident = (r.ident ?? "").trim();
    const name = (r.name ?? "").trim();
    if (lat === null || lon === null || ident === "" || name === "") continue;
    out.push({
      ident: ident.toUpperCase(),
      icaoCode: emptyToNull(r.icao_code ?? "")?.toUpperCase() ?? null,
      iataCode: emptyToNull(r.iata_code ?? "")?.toUpperCase() ?? null,
      gpsCode: emptyToNull(r.gps_code ?? "")?.toUpperCase() ?? null,
      localCode: emptyToNull(r.local_code ?? "")?.toUpperCase() ?? null,
      name,
      type: (r.type ?? "").trim() || "unknown",
      lat,
      lon,
      elevationFt: numOrNull(r.elevation_ft ?? ""),
      municipality: emptyToNull(r.municipality ?? ""),
      isoRegion: emptyToNull(r.iso_region ?? ""),
      isoCountry: (r.iso_country ?? "").trim() || "??",
      scheduledService: (r.scheduled_service ?? "").trim() === "yes",
    });
  }
  return out;
}

export function parseRunwaysCsv(content: string): RunwayRow[] {
  const out: RunwayRow[] = [];
  for (const r of parseCsv(content)) {
    const airportIdent = (r.airport_ident ?? "").trim().toUpperCase();
    if (airportIdent === "") continue;
    out.push({
      airportIdent,
      leIdent: emptyToNull(r.le_ident ?? ""),
      heIdent: emptyToNull(r.he_ident ?? ""),
      lengthFt: numOrNull(r.length_ft ?? ""),
      widthFt: numOrNull(r.width_ft ?? ""),
      surface: emptyToNull(r.surface ?? ""),
      lighted: (r.lighted ?? "").trim() === "1",
      closed: (r.closed ?? "").trim() === "1",
      leHeadingDeg: numOrNull(r.le_heading_degT ?? ""),
      heHeadingDeg: numOrNull(r.he_heading_degT ?? ""),
    });
  }
  return out;
}

export function parseNavaidsCsv(content: string): NavaidRow[] {
  const out: NavaidRow[] = [];
  for (const r of parseCsv(content)) {
    const lat = numOrNull(r.latitude_deg ?? "");
    const lon = numOrNull(r.longitude_deg ?? "");
    const ident = (r.ident ?? "").trim();
    if (lat === null || lon === null || ident === "") continue;
    out.push({
      ident: ident.toUpperCase(),
      name: (r.name ?? "").trim() || ident,
      type: (r.type ?? "").trim() || "unknown",
      frequencyKhz: numOrNull(r.frequency_khz ?? ""),
      lat,
      lon,
      elevationFt: numOrNull(r.elevation_ft ?? ""),
      isoCountry: emptyToNull(r.iso_country ?? ""),
      magneticVariationDeg: numOrNull(r.magnetic_variation_deg ?? ""),
      usageType: emptyToNull(r.usageType ?? ""),
      associatedAirport: emptyToNull(r.associated_airport ?? ""),
    });
  }
  return out;
}
