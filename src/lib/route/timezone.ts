import tzLookup from "@photostructure/tz-lookup";

// IANA zone for a coordinate. tz-lookup is a compiled boundary database —
// deterministic and offline, exactly what §8.5 requires.
export function zoneFor(lat: number, lon: number): string {
  try {
    return tzLookup(lat, lon);
  } catch {
    return "UTC"; // out-of-domain coordinates (mid-ocean edge cases)
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** "2026-07-18 10:15 CDT" — DST resolution is Intl's, backed by the IANA db. */
export function formatLocal(utcIso: string, tz: string): string {
  const parts = formatter(tz).formatToParts(new Date(utcIso));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute",
  )} ${get("timeZoneName")}`;
}
