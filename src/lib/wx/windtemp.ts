// FB (winds and temperatures aloft) fixed-width bulletin parser.
// Verified decoding rules (PLAN.md §7.1 gotchas):
// - column positions come from the FT header line; station rows are
//   right-aligned under those columns, and high-elevation stations leave
//   low-altitude columns BLANK (e.g. DEN omits 3000/6000)
// - 4-char groups DDss = dir*10 / speed, no temp (3000 ft column)
// - 7-char groups DDss+TT / DDss-TT include temperature
// - 6-char groups DDssTT (30000 ft and above): temps implied negative
// - 9900 = light and variable (dir null, speed 0)
// - coded dir > 36 means dir-50 and speed+100 (e.g. 7545 = 250 deg, 145 kt)

export interface WindTempEntry {
  station: string;
  levelFt: number;
  windDirDeg: number | null;
  windSpeedKt: number;
  tempC: number | null;
  lightVariable: boolean;
}

export interface WindTempBulletin {
  basedOn: string;    // UTC ISO
  validAt: string;    // UTC ISO
  forUseFrom: string; // UTC ISO
  forUseTo: string;   // UTC ISO
  entries: WindTempEntry[];
}

/** Decode one group like "2722", "2711+17", "321231", "9900-15". */
export function decodeGroup(raw: string, levelFt: number): Omit<WindTempEntry, "station" | "levelFt"> | null {
  const g = raw.trim();
  if (!g) return null;
  const m = /^(\d{4})(?:([+-]?)(\d{2}))?$/.exec(g.replace(/\s+/g, ""));
  if (!m) return null;
  const code = m[1]!;
  let dirCode = Number(code.slice(0, 2));
  let speed = Number(code.slice(2, 4));
  let temp: number | null = null;
  if (m[3] !== undefined) {
    const t = Number(m[3]);
    // High-altitude groups omit the sign: temps are negative above 24,000 ft.
    const sign = m[2] === "-" || (m[2] === "" && levelFt > 24000) ? -1 : 1;
    temp = sign * t;
  }
  if (dirCode === 99 && speed === 0) {
    return { windDirDeg: null, windSpeedKt: 0, tempC: temp, lightVariable: true };
  }
  if (dirCode > 36) {
    dirCode -= 50;
    speed += 100;
  }
  return {
    windDirDeg: dirCode * 10,
    windSpeedKt: speed,
    tempC: temp,
    lightVariable: false,
  };
}

/** "180000Z" style time + a reference date -> UTC ISO (handles day rollover). */
function zTime(dayHourMin: string, ref: Date): string {
  const day = Number(dayHourMin.slice(0, 2));
  const hour = Number(dayHourMin.slice(2, 4));
  const min = Number(dayHourMin.slice(4, 6) || "0");
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day, hour, min));
  // If the day is far behind the reference, it's next month's rollover.
  if (d.getTime() < ref.getTime() - 15 * 86_400_000) {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString();
}

export function parseWindTemp(body: string, referenceDate = new Date()): WindTempBulletin | null {
  const lines = body.split("\n");
  const basedMatch = /DATA BASED ON (\d{6})Z/.exec(body);
  const validMatch = /VALID (\d{6})Z\s+FOR USE (\d{4})-(\d{4})Z/.exec(body);
  const header = lines.find((l) => l.trimStart().startsWith("FT "));
  if (!basedMatch || !validMatch || !header) return null;

  const basedOn = zTime(basedMatch[1]!, referenceDate);
  const validAt = zTime(validMatch[1]!, referenceDate);
  // FOR USE window is hours around the valid time; anchor to the valid date,
  // rolling across midnight when the window wraps (e.g. 1800-0600Z).
  const validDate = new Date(validAt);
  const fromH = validMatch[2]!;
  const toH = validMatch[3]!;
  const from = new Date(Date.UTC(
    validDate.getUTCFullYear(), validDate.getUTCMonth(), validDate.getUTCDate(),
    Number(fromH.slice(0, 2)), Number(fromH.slice(2, 4)),
  ));
  if (from.getTime() > validDate.getTime()) from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    Number(toH.slice(0, 2)), Number(toH.slice(2, 4)),
  ));
  if (to.getTime() <= from.getTime()) to.setUTCDate(to.getUTCDate() + 1);

  // Column layout: each level column ends where its header label ends.
  const levels: { levelFt: number; end: number }[] = [];
  const re = /(\d{4,5})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    levels.push({ levelFt: Number(m[1]), end: m.index + m[0].length });
  }

  const entries: WindTempEntry[] = [];
  const headerIdx = lines.indexOf(header);
  for (const line of lines.slice(headerIdx + 1)) {
    const sm = /^([A-Z0-9]{3})\s/.exec(line);
    if (!sm) continue;
    const station = sm[1]!;
    let prevEnd = 3;
    for (const { levelFt, end } of levels) {
      // Right-aligned columns: slice from the previous column's end to this
      // one's end; blank slices (high-elevation stations) decode to null.
      const cell = line.slice(prevEnd, end);
      prevEnd = end;
      const decoded = decodeGroup(cell, levelFt);
      if (decoded) entries.push({ station, levelFt, ...decoded });
    }
  }

  return {
    basedOn,
    validAt,
    forUseFrom: from.toISOString(),
    forUseTo: to.toISOString(),
    entries,
  };
}
