// Per-product freshness policy (PLAN.md §9.7). Consumers receive the state
// with every record; stale data can never satisfy a green-supporting rule.

export type Freshness = "fresh" | "aging" | "stale";

interface Policy {
  freshForMin: number;
  hardStaleMin: number;
}

export const FRESHNESS_POLICY: Record<string, Policy> = {
  METAR: { freshForMin: 75, hardStaleMin: 180 },
  TAF: { freshForMin: 390, hardStaleMin: 750 }, // routine issuance every 6 h + slack
  PIREP: { freshForMin: 90, hardStaleMin: 180 },
  AIRSIGMET: { freshForMin: 75, hardStaleMin: 150 }, // hourly Conv SIGMET cycle + slack
  GAIRMET: { freshForMin: 200, hardStaleMin: 400 },  // 3-h snapshots
  CWA: { freshForMin: 130, hardStaleMin: 260 },      // valid up to 2 h
  WINDTEMP: { freshForMin: 420, hardStaleMin: 800 }, // 4x daily
  AFD: { freshForMin: 780, hardStaleMin: 1560 },     // >= 2x daily per office
  ALERT: { freshForMin: 15, hardStaleMin: 60 },
};

export function freshnessOf(
  sourceType: string,
  issuedAt: string | Date | null,
  now: Date = new Date(),
): Freshness {
  if (!issuedAt) return "stale";
  const policy = FRESHNESS_POLICY[sourceType] ?? { freshForMin: 60, hardStaleMin: 120 };
  const ageMin = (now.getTime() - new Date(issuedAt).getTime()) / 60_000;
  if (ageMin < 0) return "fresh"; // issued-in-future products (forecasts) are fresh
  if (ageMin <= policy.freshForMin) return "fresh";
  if (ageMin <= policy.hardStaleMin) return "aging";
  return "stale";
}
