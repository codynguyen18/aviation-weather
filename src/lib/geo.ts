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
