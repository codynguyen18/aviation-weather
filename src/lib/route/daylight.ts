import * as SunCalc from "suncalc";

import type { Daylight } from "@/lib/route/types";

// Day / civil-twilight / night at a time and place, using NOAA solar
// equations via suncalc (±1-2 min vs the USNO almanac — verified against the
// USNO API in tests). Conservative reading for aviation: anything past the
// end of civil twilight is night.
//
// suncalc returns events for one calendar day; an instant near midnight UTC
// can belong to the previous or next solar day, so classify against the
// events of the surrounding three days rather than trusting one date.
const DAY_MS = 86_400_000;

export function daylightAt(date: Date, lat: number, lon: number): Daylight {
  for (const offset of [-1, 0, 1]) {
    const t = SunCalc.getTimes(new Date(date.getTime() + offset * DAY_MS), lat, lon);
    const { dawn, sunrise, sunset, dusk } = t;
    const valid = (d: Date | null | undefined): d is Date =>
      d instanceof Date && !isNaN(+d);
    if (!valid(dawn) || !valid(sunrise) || !valid(sunset) || !valid(dusk)) {
      continue; // no event that day (high latitudes; out of CONUS scope)
    }
    if (date >= sunrise && date < sunset) return "day";
    if (
      (date >= dawn && date < sunrise) ||
      (date >= sunset && date < dusk)
    ) {
      return "civil-twilight";
    }
  }
  // Not inside any day/twilight window of the surrounding days -> night.
  // (If all three days lacked sun events entirely, night is the conservative
  // answer for a rules engine that must never upgrade missing data.)
  return "night";
}
