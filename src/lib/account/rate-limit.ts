import type { Sql } from "postgres";

// Sliding-window rate limiting in Postgres (PLAN.md §17) — no Redis at MVP.
// One row per counted event; expired rows are pruned on each check.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMin: number;
}

export async function checkRateLimit(
  sql: Sql,
  key: string,
  max: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  await sql`DELETE FROM rate_limit_events WHERE key = ${key} AND at < ${cutoff}`;
  const [row] = await sql`
    SELECT count(*)::int AS n, min(at) AS oldest
    FROM rate_limit_events WHERE key = ${key}
  `;
  const n = Number(row!.n);
  if (n >= max) {
    const oldestMs = row!.oldest ? Date.parse(row!.oldest as string) : Date.now();
    const retryAfterMin = Math.max(
      1,
      Math.ceil((oldestMs + windowMinutes * 60_000 - Date.now()) / 60_000),
    );
    return { allowed: false, remaining: 0, retryAfterMin };
  }
  await sql`INSERT INTO rate_limit_events (key) VALUES (${key})`;
  return { allowed: true, remaining: max - n - 1, retryAfterMin: 0 };
}
