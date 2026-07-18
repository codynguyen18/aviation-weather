// Great-circle helpers on a mean-Earth sphere. These are DISPLAY/estimation
// helpers only — authoritative geometry (corridor buffers, hazard
// intersections) always runs in PostGIS on the WGS-84 spheroid (PLAN.md §10).
// Spherical vs spheroidal distance differs by up to ~0.5% at CONUS latitudes,
// which is why tests compare the two within that tolerance rather than
// expecting equality.

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius
export const METERS_PER_NM = 1852;

export interface LatLon {
  lat: number; // degrees, north positive
  lon: number; // degrees, east positive
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine). */
export function greatCircleMeters(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Great-circle distance in nautical miles. */
export function greatCircleNm(a: LatLon, b: LatLon): number {
  return greatCircleMeters(a, b) / METERS_PER_NM;
}

/**
 * Point at fraction f (0..1) along the great circle from a to b
 * (spherical interpolation). Undefined for antipodal points, which cannot
 * occur on CONUS routes.
 */
export function intermediatePoint(a: LatLon, b: LatLon, f: number): LatLon {
  const lat1 = toRad(a.lat);
  const lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat);
  const lon2 = toRad(b.lon);
  const delta = greatCircleMeters(a, b) / EARTH_RADIUS_M; // angular distance
  if (delta === 0) return { ...a };
  const sinDelta = Math.sin(delta);
  const A = Math.sin((1 - f) * delta) / sinDelta;
  const B = Math.sin(f * delta) / sinDelta;
  const x =
    A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y =
    A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

/** Initial true course from a to b, degrees 0–360. */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}
