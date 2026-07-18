import type { Sql } from "postgres";

// Wind field from ingested FB winds-aloft bulletins (PLAN.md §8.5, §9.5).
// Station-point data: nearest station (within a hard limit), linear altitude
// interpolation between bracketing levels, and the bulletin whose FOR-USE
// window contains the ETA. Returns null — never a silent zero — when no
// station or window applies; callers flag the segment as winds-unavailable.

export interface Wind {
  dirDeg: number | null; // null = light & variable
  speedKt: number;
  station: string;
  levelLoFt: number;
  levelHiFt: number;
  sourceRecordId: string;
}

export type WindLookup = (
  lat: number,
  lon: number,
  altFt: number,
  when: Date,
) => Wind | null;

export interface WindField {
  at: WindLookup;
  stations: number;
  sourceRecordIds: string[];
}

const MAX_STATION_NM = 150;

interface LevelRow {
  levelFt: number;
  dirDeg: number | null;
  speedKt: number;
  lightVariable: boolean;
}

interface StationData {
  station: string;
  lat: number;
  lon: number;
  windows: {
    from: number;
    to: number;
    sourceRecordId: string;
    levels: LevelRow[];
  }[];
}

export async function loadWindField(
  sql: Sql,
  window: { from: Date; to: Date },
): Promise<WindField> {
  const rows = await sql`
    SELECT w.station, w.level_ft, w.wind_dir_deg, w.wind_speed_kt,
           w.light_variable, w.for_use_from, w.for_use_to, w.source_record_id
    FROM winds_aloft w
    WHERE w.for_use_to >= ${window.from.toISOString()}
      AND w.for_use_from <= ${window.to.toISOString()}
    ORDER BY w.station, w.for_use_from, w.level_ft
  `;
  if (rows.length === 0) {
    return { at: () => null, stations: 0, sourceRecordIds: [] };
  }

  const stationIdents = [...new Set(rows.map((r) => r.station as string))];
  // FB points are usually VORs; some resolve via the K-prefixed airport.
  const coordRows = await sql`
    SELECT DISTINCT ON (ident) ident, lat, lon FROM (
      SELECT n.ident, ST_Y(n.geom::geometry) AS lat, ST_X(n.geom::geometry) AS lon, 1 AS pri
      FROM nav_navaids n
      JOIN nav_datasets d ON d.id = n.dataset_id AND d.active
      WHERE n.ident IN ${sql(stationIdents)} AND (n.iso_country = 'US' OR n.iso_country IS NULL)
      UNION ALL
      SELECT substr(a.ident, 2), ST_Y(a.geom::geometry), ST_X(a.geom::geometry), 2
      FROM nav_airports a
      JOIN nav_datasets d ON d.id = a.dataset_id AND d.active
      WHERE a.ident IN ${sql(stationIdents.map((s) => "K" + s))}
    ) c
    ORDER BY ident, pri
  `;
  const coords = new Map(
    coordRows.map((r) => [r.ident as string, { lat: Number(r.lat), lon: Number(r.lon) }]),
  );

  const stations = new Map<string, StationData>();
  const recordIds = new Set<string>();
  for (const r of rows) {
    const ident = r.station as string;
    const c = coords.get(ident);
    if (!c) continue; // no coordinates -> unusable station
    let s = stations.get(ident);
    if (!s) {
      s = { station: ident, lat: c.lat, lon: c.lon, windows: [] };
      stations.set(ident, s);
    }
    const from = new Date(r.for_use_from as string).getTime();
    const to = new Date(r.for_use_to as string).getTime();
    const srid = r.source_record_id as string;
    recordIds.add(srid);
    let w = s.windows.find((x) => x.from === from && x.sourceRecordId === srid);
    if (!w) {
      w = { from, to, sourceRecordId: srid, levels: [] };
      s.windows.push(w);
    }
    w.levels.push({
      levelFt: Number(r.level_ft),
      dirDeg: r.wind_dir_deg === null ? null : Number(r.wind_dir_deg),
      speedKt: Number(r.wind_speed_kt),
      lightVariable: Boolean(r.light_variable),
    });
  }

  const stationList = [...stations.values()];

  const at: WindLookup = (lat, lon, altFt, when) => {
    // Nearest station by approximate degree distance (selection only).
    let best: StationData | null = null;
    let bestD = Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (const s of stationList) {
      const d =
        (s.lat - lat) ** 2 + ((s.lon - lon) * cosLat) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return null;
    const approxNm = Math.sqrt(bestD) * 60;
    if (approxNm > MAX_STATION_NM) return null;

    const t = when.getTime();
    const win =
      best.windows.find((w) => t >= w.from && t < w.to) ??
      best.windows.reduce<StationData["windows"][number] | null>(
        (acc, w) => {
          const dist = Math.min(Math.abs(t - w.from), Math.abs(t - w.to));
          const accDist = acc
            ? Math.min(Math.abs(t - acc.from), Math.abs(t - acc.to))
            : Infinity;
          return dist < accDist ? w : acc;
        },
        null,
      );
    if (!win || win.levels.length === 0) return null;
    // Do not stretch a bulletin more than 3 h beyond its for-use window.
    if (t < win.from - 3 * 3_600_000 || t > win.to + 3 * 3_600_000) return null;

    const levels = win.levels;
    const below = [...levels].filter((l) => l.levelFt <= altFt).pop();
    const above = levels.find((l) => l.levelFt > altFt);
    const pick = (l: LevelRow): { dirDeg: number | null; speedKt: number } =>
      l.lightVariable
        ? { dirDeg: null, speedKt: 0 }
        : { dirDeg: l.dirDeg, speedKt: l.speedKt };

    let dirDeg: number | null;
    let speedKt: number;
    let lo: LevelRow;
    let hi: LevelRow;
    if (below && above) {
      lo = below;
      hi = above;
      const f = (altFt - lo.levelFt) / (hi.levelFt - lo.levelFt);
      const a = pick(lo);
      const b = pick(hi);
      speedKt = a.speedKt + f * (b.speedKt - a.speedKt);
      if (a.dirDeg === null || b.dirDeg === null) {
        dirDeg = f < 0.5 ? a.dirDeg : b.dirDeg;
      } else {
        // Interpolate direction the short way around the compass.
        let delta = b.dirDeg - a.dirDeg;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        dirDeg = (a.dirDeg + f * delta + 360) % 360;
      }
    } else {
      const only = (below ?? above)!;
      lo = only;
      hi = only;
      const v = pick(only);
      dirDeg = v.dirDeg;
      speedKt = v.speedKt;
    }
    return {
      dirDeg,
      speedKt,
      station: best.station,
      levelLoFt: lo.levelFt,
      levelHiFt: hi.levelFt,
      sourceRecordId: win.sourceRecordId,
    };
  };

  return { at, stations: stationList.length, sourceRecordIds: [...recordIds] };
}
