// Hazard-product normalizers: AWC GeoJSON features -> hazard rows.
// Live-verified traps handled here (PLAN.md §7.1):
// - G-AIRMET base/top are STRINGS in hundreds of feet ("090", "SFC");
//   airsigmet/CWA altitudes are integer feet
// - Convective SIGMET api validTimeTo can be truncated to the next hourly
//   issuance; the raw text "VALID UNTIL hhmmZ" is authoritative — we keep
//   the LATER of the two (conservative)
// - hazard vocabularies differ per product; mapped to one internal enum

export type HazardKind =
  | "CONVECTIVE" | "TURB" | "ICE" | "IFR" | "MTN_OBSC"
  | "LLWS" | "SFC_WIND" | "FZLVL" | "PCPN" | "OTHER";

export interface NormalizedHazard {
  product: "AIRSIGMET" | "GAIRMET" | "CWA";
  hazard: HazardKind;
  severity: string | null;
  qualifier: string | null;
  geometry: object; // GeoJSON geometry
  floorFtMsl: number | null;
  ceilingFtMsl: number | null;
  movementDirDeg: number | null;
  movementSpdKt: number | null;
  forecastHour: number | null;
  validFrom: string;
  validTo: string;
  rawText: string | null;
  externalKey: string;
}

interface Feature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

function iso(v: unknown): string | null {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return new Date(v * 1000).toISOString(); // epoch seconds (format=json)
  }
  return null;
}

/** "VALID UNTIL 0555Z" + a from-date -> ISO, rolling past midnight if needed. */
export function rawValidUntil(rawText: string, validFromIso: string): string | null {
  const m = /VALID UNTIL (\d{2})(\d{2})Z/.exec(rawText);
  if (!m) return null;
  const from = new Date(validFromIso);
  const d = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    Number(m[1]), Number(m[2]),
  ));
  if (d.getTime() < from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

const AIRSIGMET_HAZARDS: Record<string, HazardKind> = {
  CONVECTIVE: "CONVECTIVE", CONV: "CONVECTIVE", TS: "CONVECTIVE",
  TURB: "TURB", ICE: "ICE", ICING: "ICE", IFR: "IFR",
  "MTN OBSCN": "MTN_OBSC", MTW: "TURB", ASH: "OTHER", VA: "OTHER",
};

export function normalizeAirsigmet(f: Feature): NormalizedHazard | null {
  const p = f.properties ?? {};
  const geometry = f.geometry;
  const validFrom = iso(p.validTimeFrom);
  let validTo = iso(p.validTimeTo);
  const rawText = str(p.rawAirSigmet);
  if (!geometry?.type || !validFrom || !validTo) return null;
  if (rawText) {
    const rawTo = rawValidUntil(rawText, validFrom);
    if (rawTo && Date.parse(rawTo) > Date.parse(validTo)) validTo = rawTo;
  }
  const hazardRaw = String(p.hazard ?? "").toUpperCase();
  const hazard = AIRSIGMET_HAZARDS[hazardRaw] ?? "OTHER";
  return {
    product: "AIRSIGMET",
    hazard,
    severity: p.severity !== null && p.severity !== undefined ? String(p.severity) : null,
    qualifier: str(p.airSigmetType),
    geometry,
    // Convective SIGMETs encode only tops; floor is effectively the surface.
    floorFtMsl: num(p.altitudeLow1) ?? num(p.altitudeLow2) ?? (hazard === "CONVECTIVE" ? 0 : null),
    ceilingFtMsl: num(p.altitudeHi2) ?? num(p.altitudeHi1),
    movementDirDeg: num(p.movementDir),
    movementSpdKt: num(p.movementSpd),
    forecastHour: null,
    validFrom,
    validTo,
    rawText,
    externalKey: `AIRSIGMET:${str(p.icaoId) ?? "?"}:${str(p.alphaChar) ?? ""}${String(p.seriesId ?? "")}:${validFrom}`,
  };
}

const GAIRMET_HAZARDS: Record<string, HazardKind> = {
  "TURB-HI": "TURB", "TURB-LO": "TURB", TURB: "TURB", LLWS: "LLWS",
  SFC_WND: "SFC_WIND", SFC_WIND: "SFC_WIND", IFR: "IFR",
  MT_OBSC: "MTN_OBSC", ICE: "ICE", FZLVL: "FZLVL", M_FZLVL: "FZLVL",
};

/** "090" -> 9000; "SFC" -> 0; null -> null. Hundreds of feet, verified live. */
export function gairmetLevelToFt(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  if (v.trim().toUpperCase() === "SFC") return 0;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n * 100 : null;
}

const GAIRMET_SNAPSHOT_HALF_WINDOW_MS = 90 * 60_000; // 3-h snapshot spacing

export function normalizeGairmet(f: Feature): NormalizedHazard | null {
  const p = f.properties ?? {};
  const geometry = f.geometry;
  const validAt = iso(p.validTime);
  if (!geometry?.type || !validAt) return null;
  const hazardRaw = String(p.hazard ?? "").toUpperCase();
  const hazard = GAIRMET_HAZARDS[hazardRaw] ?? "OTHER";
  const fh = num(p.forecast) ?? (typeof p.forecast === "string" ? Number(p.forecast) : null);
  const t = Date.parse(validAt);
  return {
    product: "GAIRMET",
    hazard,
    severity: str(p.severity),
    qualifier: str(p.dueTo) ?? str(p.product),
    geometry,
    floorFtMsl: gairmetLevelToFt(p.base),
    ceilingFtMsl: gairmetLevelToFt(p.top),
    movementDirDeg: null,
    movementSpdKt: null,
    forecastHour: fh !== null && Number.isFinite(fh) ? fh : null,
    validFrom: new Date(t - GAIRMET_SNAPSHOT_HALF_WINDOW_MS).toISOString(),
    validTo: new Date(t + GAIRMET_SNAPSHOT_HALF_WINDOW_MS).toISOString(),
    rawText: null,
    externalKey: `GAIRMET:${str(p.product) ?? "?"}:${hazardRaw}:${validAt}:${str(p.tag) ?? ""}`,
  };
}

const CWA_HAZARDS: Record<string, HazardKind> = {
  TS: "CONVECTIVE", TURB: "TURB", ICE: "ICE", IFR: "IFR", PCPN: "PCPN", UNK: "OTHER",
};

export function normalizeCwa(f: Feature): NormalizedHazard | null {
  const p = f.properties ?? {};
  const geometry = f.geometry;
  const validFrom = iso(p.validTimeFrom);
  const validTo = iso(p.validTimeTo);
  if (!geometry?.type || !validFrom || !validTo) return null;
  const hazardRaw = String(p.hazard ?? "UNK").toUpperCase();
  return {
    product: "CWA",
    hazard: CWA_HAZARDS[hazardRaw] ?? "OTHER",
    severity: null,
    qualifier: str(p.qualifier),
    geometry,
    floorFtMsl: num(p.base),
    ceilingFtMsl: num(p.top),
    movementDirDeg: null,
    movementSpdKt: null,
    forecastHour: null,
    validFrom,
    validTo,
    rawText: str(p.cwaText),
    externalKey: `CWA:${str(p.cwsu) ?? "?"}:${String(p.seriesId ?? "?")}:${validFrom}`,
  };
}
