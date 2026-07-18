// Normalizers: AWC Data API JSON -> typed rows (PLAN.md §9). Pure functions,
// fixture-tested. Unit rules verified against live responses:
// - obsTime / timeFrom / timeTo are epoch SECONDS in format=json
// - visib may be a string "10+" / "6+" (capped) or a number
// - altim is hectopascals (1017.7), NOT inches of mercury — convert
// - cloud bases are feet AGL in JSON format
// - PIREP fltLvl is hundreds of feet MSL (FL072 = 7,200 ft)
// Missing values stay null and are listed in missingFields — a METAR without
// visibility must never read as "unlimited".

export interface NormalizedMetar {
  station: string;
  observedAt: string; // UTC ISO
  lat: number | null;
  lon: number | null;
  flightCategory: string | null;
  tempC: number | null;
  dewpointC: number | null;
  windDirDeg: number | null; // null when VRB/missing (see missingFields)
  windSpeedKt: number | null;
  windGustKt: number | null;
  visibilitySm: number | null;
  ceilingFtAgl: number | null; // null = no ceiling
  altimInHg: number | null;
  wxString: string | null;
  clouds: { cover: string; baseFtAgl: number | null }[];
  missingFields: string[];
  rawText: string;
}

const HPA_TO_INHG = 0.029529983;

function epochToIso(sec: unknown): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

/** "10+" -> {value:10, capped:true}; 2.5 -> {value:2.5}; null/"" -> null */
function parseVisib(v: unknown): { value: number; capped: boolean } | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return { value: v, capped: false };
  }
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)(\+)?$/.exec(v.trim());
    if (m) return { value: Number(m[1]), capped: m[2] === "+" };
  }
  return null;
}

function parseWindDir(v: unknown): { deg: number | null; variable: boolean } {
  if (typeof v === "number" && Number.isFinite(v)) {
    return { deg: v, variable: false };
  }
  if (typeof v === "string" && v.toUpperCase() === "VRB") {
    return { deg: null, variable: true };
  }
  return { deg: null, variable: false };
}

interface CloudLayer {
  cover: string;
  baseFtAgl: number | null;
}

function parseClouds(raw: unknown): CloudLayer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      cover: String(c.cover ?? "UNK"),
      baseFtAgl:
        typeof c.base === "number" && Number.isFinite(c.base) ? c.base : null,
    }));
}

/** Lowest broken/overcast/obscured layer = ceiling; clear sky = null. */
export function ceilingFrom(clouds: CloudLayer[], vertVisFt?: number | null): number | null {
  const CEILING_COVERS = new Set(["BKN", "OVC", "OVX", "VV"]);
  const bases = clouds
    .filter((c) => CEILING_COVERS.has(c.cover.toUpperCase()) && c.baseFtAgl !== null)
    .map((c) => c.baseFtAgl!);
  if (typeof vertVisFt === "number" && Number.isFinite(vertVisFt)) {
    bases.push(vertVisFt);
  }
  return bases.length ? Math.min(...bases) : null;
}

/** Standard US flight-category ladder from ceiling and visibility. */
export function flightCategory(
  ceilingFtAgl: number | null,
  visibilitySm: number | null,
): string | null {
  if (ceilingFtAgl === null && visibilitySm === null) return null;
  const c = ceilingFtAgl ?? Infinity;
  const v = visibilitySm ?? Infinity;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}

export function normalizeMetar(m: Record<string, unknown>): NormalizedMetar | null {
  const station = typeof m.icaoId === "string" ? m.icaoId : null;
  const observedAt = epochToIso(m.obsTime);
  const rawText = typeof m.rawOb === "string" ? m.rawOb : null;
  if (!station || !observedAt || !rawText) return null;

  const missing: string[] = [];
  const vis = parseVisib(m.visib);
  if (!vis) missing.push("visibility");
  else if (vis.capped) missing.push("visibility_capped");
  const wind = parseWindDir(m.wdir);
  if (wind.variable) missing.push("wind_variable");
  const clouds = parseClouds(m.clouds);
  const ceiling = ceilingFrom(clouds);
  if (typeof m.temp !== "number") missing.push("temperature");
  if (m.wspd === null || m.wspd === undefined) missing.push("wind");

  const cat =
    typeof m.fltCat === "string" && m.fltCat
      ? m.fltCat
      : flightCategory(ceiling, vis?.value ?? null);

  return {
    station,
    observedAt,
    lat: typeof m.lat === "number" ? m.lat : null,
    lon: typeof m.lon === "number" ? m.lon : null,
    flightCategory: cat,
    tempC: typeof m.temp === "number" ? m.temp : null,
    dewpointC: typeof m.dewp === "number" ? m.dewp : null,
    windDirDeg: wind.deg,
    windSpeedKt: typeof m.wspd === "number" ? m.wspd : null,
    windGustKt: typeof m.wgst === "number" ? m.wgst : null,
    visibilitySm: vis?.value ?? null,
    ceilingFtAgl: ceiling,
    altimInHg:
      typeof m.altim === "number" ? +(m.altim * HPA_TO_INHG).toFixed(2) : null,
    wxString: typeof m.wxString === "string" ? m.wxString : null,
    clouds,
    missingFields: missing,
    rawText,
  };
}

export interface NormalizedTafGroup {
  station: string;
  issuedAt: string;
  groupSeq: number;
  groupType: string; // BASE | FM | BECMG | TEMPO | PROB
  probability: number | null;
  validFrom: string;
  validTo: string;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  visibilitySm: number | null;
  ceilingFtAgl: number | null;
  wxString: string | null;
  clouds: CloudLayer[];
  rawText: string; // full raw TAF
}

export function normalizeTaf(t: Record<string, unknown>): NormalizedTafGroup[] {
  const station = typeof t.icaoId === "string" ? t.icaoId : null;
  const issuedAt =
    typeof t.issueTime === "string"
      ? new Date(t.issueTime).toISOString()
      : epochToIso(t.issueTime);
  const rawText = typeof t.rawTAF === "string" ? t.rawTAF : null;
  const fcsts = Array.isArray(t.fcsts) ? t.fcsts : [];
  if (!station || !issuedAt || !rawText || fcsts.length === 0) return [];

  return fcsts
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f, i) => {
      const vis = parseVisib(f.visib);
      const wind = parseWindDir(f.wdir);
      const clouds = parseClouds(f.clouds);
      const vertVis =
        typeof f.vertVis === "number" && Number.isFinite(f.vertVis)
          ? f.vertVis
          : null;
      const change =
        typeof f.fcstChange === "string" && f.fcstChange
          ? f.fcstChange.toUpperCase()
          : null;
      const prob =
        typeof f.probability === "number" && Number.isFinite(f.probability)
          ? f.probability
          : null;
      const from = epochToIso(f.timeFrom);
      const to = epochToIso(f.timeTo);
      if (!from || !to) return null;
      return {
        station,
        issuedAt,
        groupSeq: i,
        groupType: prob !== null && !change ? "PROB" : (change ?? "BASE"),
        probability: prob,
        validFrom: from,
        validTo: to,
        windDirDeg: wind.deg,
        windSpeedKt: typeof f.wspd === "number" ? f.wspd : null,
        windGustKt: typeof f.wgst === "number" ? f.wgst : null,
        visibilitySm: vis?.value ?? null,
        ceilingFtAgl: ceilingFrom(clouds, vertVis),
        wxString: typeof f.wxString === "string" ? f.wxString : null,
        clouds,
        rawText,
      } satisfies NormalizedTafGroup;
    })
    .filter((g): g is NormalizedTafGroup => g !== null);
}

export interface NormalizedPirep {
  observedAt: string;
  lat: number;
  lon: number;
  altitudeFtMsl: number | null;
  altitudeNote: string | null;
  aircraftType: string | null;
  reportType: string; // PIREP | AIREP
  urgent: boolean;
  turbulence: { intensity: string; type: string | null; freq: string | null; baseFtMsl: number | null; topFtMsl: number | null }[];
  icing: { intensity: string; type: string | null; baseFtMsl: number | null; topFtMsl: number | null }[];
  clouds: CloudLayer[];
  wxString: string | null;
  tempC: number | null;
  rawText: string;
}

const hundredsToFt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v * 100 : null;

export function normalizePirep(p: Record<string, unknown>): NormalizedPirep | null {
  const observedAt = epochToIso(p.obsTime);
  const rawText = typeof p.rawOb === "string" ? p.rawOb : null;
  const lat = typeof p.lat === "number" ? p.lat : null;
  const lon = typeof p.lon === "number" ? p.lon : null;
  if (!observedAt || !rawText || lat === null || lon === null) return null;

  const turb: NormalizedPirep["turbulence"] = [];
  for (const n of [1, 2] as const) {
    const int = p[`tbInt${n}`];
    if (typeof int === "string" && int.trim()) {
      turb.push({
        intensity: int.trim(),
        type: typeof p[`tbType${n}`] === "string" && (p[`tbType${n}`] as string).trim() ? (p[`tbType${n}`] as string).trim() : null,
        freq: typeof p[`tbFreq${n}`] === "string" && (p[`tbFreq${n}`] as string).trim() ? (p[`tbFreq${n}`] as string).trim() : null,
        baseFtMsl: hundredsToFt(p[`tbBas${n}`]),
        topFtMsl: hundredsToFt(p[`tbTop${n}`]),
      });
    }
  }
  const ice: NormalizedPirep["icing"] = [];
  for (const n of [1, 2] as const) {
    const int = p[`icgInt${n}`];
    if (typeof int === "string" && int.trim()) {
      ice.push({
        intensity: int.trim(),
        type: typeof p[`icgType${n}`] === "string" && (p[`icgType${n}`] as string).trim() ? (p[`icgType${n}`] as string).trim() : null,
        baseFtMsl: hundredsToFt(p[`icgBas${n}`]),
        topFtMsl: hundredsToFt(p[`icgTop${n}`]),
      });
    }
  }

  // Urgent PIREPs are transmitted as UUA (vs routine UA).
  const urgent = /(^|\s)UUA(\s|\/)/.test(rawText);

  const fltLvl = p.fltLvl;
  const altitudeFtMsl =
    typeof fltLvl === "number" && Number.isFinite(fltLvl)
      ? fltLvl * 100
      : null;

  return {
    observedAt,
    lat,
    lon,
    altitudeFtMsl,
    altitudeNote:
      altitudeFtMsl === null
        ? typeof fltLvl === "string" && fltLvl
          ? fltLvl
          : "UNKN"
        : typeof p.fltLvlType === "string"
          ? p.fltLvlType
          : null,
    aircraftType: typeof p.acType === "string" && p.acType ? p.acType : null,
    reportType: p.pirepType === "AIREP" ? "AIREP" : "PIREP",
    urgent,
    turbulence: turb,
    icing: ice,
    clouds: parseClouds(p.clouds),
    wxString: typeof p.wxString === "string" && p.wxString ? p.wxString : null,
    tempC: typeof p.temp === "number" ? p.temp : null,
    rawText,
  };
}
