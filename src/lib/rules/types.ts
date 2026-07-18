import { z } from "zod";

import type { RouteSegment } from "@/lib/route/types";
import type { HazardHit } from "@/lib/wx/intersect";
import type { Freshness } from "@/lib/wx/freshness";

// Rules-engine contracts (PLAN.md §11). Rules are declarative objects with a
// pure evaluate() — same context in, same evaluation out, every time.

export const RULESET_VERSION = "1.0.0";

export const pilotMinimumsSchema = z.object({
  mode: z.enum(["ifr", "vfr"]).default("ifr"),
  minCeilingFt: z.number().min(0).max(10000).default(800),
  minVisibilitySm: z.number().min(0).max(30).default(2),
  maxSurfaceWindKt: z.number().min(5).max(80).default(25),
  maxCrosswindKt: z.number().min(3).max(50).default(15),
  maxWindsAloftKt: z.number().min(10).max(150).default(45),
  nightOk: z.boolean().default(false),
  maxDutyMin: z.number().min(60).max(1800).default(840),
  fuelReserveMin: z.number().min(30).max(240).default(60),
});
export type PilotMinimums = z.infer<typeof pilotMinimumsSchema>;

export const aircraftLimitsSchema = z.object({
  fuelEnduranceMin: z.number().min(60).max(1200).default(300),
});
export type AircraftLimits = z.infer<typeof aircraftLimitsSchema>;

export interface StationObservation {
  station: string;
  observedAt: string;
  flightCategory: string | null;
  visibilitySm: number | null;
  ceilingFtAgl: number | null;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  distanceNm: number;
  freshness: Freshness;
  sourceRecordId: string;
  rawText: string;
}

export interface ForecastGroup {
  station: string;
  issuedAt: string;
  groupType: string;
  probability: number | null;
  validFrom: string;
  validTo: string;
  visibilitySm: number | null;
  ceilingFtAgl: number | null;
  windDirDeg: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  wxString: string | null;
  freshness: Freshness;
  sourceRecordId: string;
  rawText: string;
}

export interface NearbyPirep {
  observedAt: string;
  distanceNm: number;
  altitudeFtMsl: number | null;
  aircraftType: string | null;
  urgent: boolean;
  turbulence: { intensity: string }[];
  icing: { intensity: string }[];
  ageMin: number;
  sourceRecordId: string;
  rawText: string;
}

export interface RunwayInfo {
  airportIdent: string;
  headingDeg: number | null;
  ident: string | null;
}

/** Everything a rule may look at for one segment. Assembled deterministically. */
export interface SegmentContext {
  segment: RouteSegment;
  isFirst: boolean;
  isLast: boolean;
  /** Airport idents whose surface weather governs this segment (dep/dest/stops on it). */
  terminalAirports: string[];
  runways: RunwayInfo[];
  minimums: PilotMinimums;
  aircraft: AircraftLimits;
  hazards: HazardHit[];
  observations: StationObservation[];   // near-segment, newest per station
  forecastGroups: ForecastGroup[];      // groups valid during the ETA window
  pireps: NearbyPirep[];
  hazardFeedsOk: boolean;               // AIRSIGMET/GAIRMET/CWA fetch not failed
  metarFeedOk: boolean;
  tafFeedOk: boolean;
  pirepFeedOk: boolean;
  dutyStartUtc: string | null;
  departureTimeUtc: string;
  remainingFlightMinAfterSegment: number;
  totalAirborneMin: number;
}

export type RuleResultKind = "pass" | "yellow" | "red" | "unknown" | "not-applicable";
export type RuleClass = "hard-limit" | "advisory";
export type Confidence = "high" | "medium" | "low";

export interface RuleEvaluation {
  ruleId: string;
  ruleVersion: number;
  ruleClass: RuleClass;
  result: RuleResultKind;
  measured: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  confidence: Confidence;
  explanation: string;
  isHardStop: boolean;
  sourceRecordIds: string[];
  /** unknown on a safety-critical input forces the segment to Unknown. */
  safetyCritical: boolean;
}

export interface RuleDefinition {
  id: string;
  version: number;
  ruleClass: RuleClass;
  safetyCritical: boolean;
  evaluate: (ctx: SegmentContext) => RuleEvaluation | null;
}
