import { z } from "zod";

import { waypointSchema } from "@/lib/nav/resolver";

// Route & time engine types (PLAN.md §8). All times UTC ISO strings; local
// renderings carry their IANA zone so the UI can always show both.

export const performanceSchema = z.object({
  cruiseTasKt: z.number().min(40).max(400),
  climbRateFpm: z.number().min(100).max(4000).default(900),
  climbTasKt: z.number().min(40).max(300).default(130),
  descentRateFpm: z.number().min(100).max(4000).default(500),
  descentTasKt: z.number().min(40).max(350).default(140),
});
export type Performance = z.infer<typeof performanceSchema>;

export const routeWaypointSchema = waypointSchema.extend({
  isFuelStop: z.boolean().default(false),
  groundMinutes: z.number().min(0).max(24 * 60).default(45),
});
export type RouteWaypoint = z.infer<typeof routeWaypointSchema>;

export const routeOptionsSchema = z.object({
  departureTimeUtc: z.string().datetime({ offset: true }),
  cruiseAltitudeFt: z.number().min(500).max(30000),
  performance: performanceSchema,
  segmentMaxNm: z.number().min(10).max(200).default(50),
  corridorWidthNm: z.number().min(5).max(60).default(25),
});
export type RouteOptions = z.infer<typeof routeOptionsSchema>;

export type Daylight = "day" | "civil-twilight" | "night";

export type FlightPhase = "climb" | "cruise" | "descent" | "mixed" | "ground";

export interface SegmentTime {
  entryUtc: string;
  exitUtc: string;
  entryLocal: string; // e.g. "2026-07-18 10:15 CDT"
  exitLocal: string;
  entryTz: string; // IANA zone at segment entry point
  exitTz: string;
  entryDaylight: Daylight;
  exitDaylight: Daylight;
}

export interface RouteSegment {
  seq: number;
  startIdent: string; // waypoint ident or synthetic split point label
  endIdent: string;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  /** Densified great-circle points [lon, lat] for map display & corridor. */
  points: [number, number][];
  distanceNm: number;
  cumulativeDistanceNm: number; // at segment exit
  altitudeFt: number; // representative altitude (cruise, or mid-phase)
  phase: FlightPhase;
  groundspeedKt: number; // wind-adjusted when winds are available
  /** Positive = headwind slowing the aircraft; negative = tailwind. */
  headwindKt: number | null;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windStation: string | null;
  windSourceRecordId: string | null;
  /** 'fb' = FB winds applied; 'none' = zero-wind fallback (flagged, never silent). */
  windSource: "fb" | "none";
  time: SegmentTime;
}

export interface GroundStop {
  ident: string;
  arriveUtc: string;
  departUtc: string;
  groundMinutes: number;
}

export interface RouteModel {
  waypoints: { ident: string; lat: number; lon: number }[];
  segments: RouteSegment[];
  groundStops: GroundStop[];
  totals: {
    distanceNm: number;
    airborneMinutes: number;
    groundMinutes: number;
    departureUtc: string;
    arrivalUtc: string;
    arrivalLocal: string;
    arrivalTz: string;
    arrivalDaylight: Daylight;
  };
  engine: { version: string; wind: "zero-wind" | "fb-winds" };
}
