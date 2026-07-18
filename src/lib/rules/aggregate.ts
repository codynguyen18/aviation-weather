import { RULES } from "@/lib/rules/catalog";
import type {
  Confidence,
  RuleEvaluation,
  SegmentContext,
} from "@/lib/rules/types";

// Segment rating aggregation (PLAN.md §11.3). Ordering:
//   red > unknown(safety-critical) > yellow > green
// A segment with zero applicable weather data is Unknown, never green —
// absence of hazard data is not evidence of absence of hazards.

export type SegmentRating = "green" | "yellow" | "red" | "unknown";

export interface SegmentAssessment {
  segmentSeq: number;
  rating: SegmentRating;
  confidence: Confidence;
  summary: string;
  hardStops: string[];
  evaluations: RuleEvaluation[];
}

export function evaluateSegment(ctx: SegmentContext): SegmentAssessment {
  const evaluations = RULES
    .map((r) => r.evaluate(ctx))
    .filter((e): e is RuleEvaluation => e !== null);

  const reds = evaluations.filter((e) => e.result === "red");
  const criticalUnknowns = evaluations.filter(
    (e) => e.result === "unknown" && e.safetyCritical,
  );
  const softUnknowns = evaluations.filter(
    (e) => e.result === "unknown" && !e.safetyCritical,
  );
  const yellows = evaluations.filter((e) => e.result === "yellow");

  const noData =
    !ctx.hazardFeedsOk &&
    ctx.observations.length === 0 &&
    ctx.forecastGroups.length === 0;

  let rating: SegmentRating;
  let summary: string;
  if (reds.length > 0) {
    rating = "red";
    summary = reds[0]!.explanation;
  } else if (criticalUnknowns.length > 0 || noData) {
    rating = "unknown";
    summary = criticalUnknowns[0]?.explanation
      ?? "No usable weather information for this segment — treat as unknown, not as clear";
  } else if (yellows.length > 0) {
    rating = "yellow";
    summary = yellows[0]!.explanation;
  } else {
    rating = "green";
    summary = "No conflicts with your minimums in the available data";
  }

  const anyAging =
    ctx.observations.some((o) => o.freshness === "aging") ||
    ctx.forecastGroups.some((f) => f.freshness === "aging");
  const confidence: Confidence =
    softUnknowns.length > 0 || criticalUnknowns.length > 0
      ? "low"
      : anyAging || evaluations.some((e) => e.confidence === "low")
        ? "medium"
        : "high";

  return {
    segmentSeq: ctx.segment.seq,
    rating,
    confidence,
    summary,
    hardStops: evaluations.filter((e) => e.isHardStop).map((e) => e.explanation),
    evaluations,
  };
}

export interface TripSummary {
  worstRating: SegmentRating;
  counts: Record<SegmentRating, number>;
  hardStops: string[];
  unknownSegments: number[];
}

export function summarizeTrip(assessments: SegmentAssessment[]): TripSummary {
  const order: SegmentRating[] = ["green", "yellow", "unknown", "red"];
  const counts: Record<SegmentRating, number> = {
    green: 0, yellow: 0, red: 0, unknown: 0,
  };
  let worst: SegmentRating = "green";
  for (const a of assessments) {
    counts[a.rating] += 1;
    if (order.indexOf(a.rating) > order.indexOf(worst)) worst = a.rating;
  }
  return {
    worstRating: worst,
    counts,
    hardStops: assessments.flatMap((a) => a.hardStops),
    unknownSegments: assessments
      .filter((a) => a.rating === "unknown")
      .map((a) => a.segmentSeq),
  };
}
