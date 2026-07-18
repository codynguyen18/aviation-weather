import type { Sql } from "postgres";
import { z } from "zod";

import { performanceSchema } from "@/lib/route/types";
import { aircraftLimitsSchema, pilotMinimumsSchema } from "@/lib/rules/types";
import { briefingRequestSchema } from "@/lib/briefing/generate";

// Per-user persistence (PLAN.md §17): every query here is scoped by user_id
// at the SQL layer, so cross-tenant reads are impossible by construction.
// Deletions are hard deletes; user-owned rows cascade from the users table.

export const aircraftProfileSchema = z.object({
  name: z.string().min(1).max(60),
  performance: performanceSchema,
  limits: aircraftLimitsSchema,
});

export const minimumsProfileSchema = z.object({
  name: z.string().min(1).max(60),
  minimums: pilotMinimumsSchema,
});

export const flightPlanSchema = z.object({
  name: z.string().min(1).max(80),
  request: briefingRequestSchema,
});

export async function audit(
  sql: Sql,
  userId: string | null,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`
    INSERT INTO audit_events (user_id, kind, detail)
    VALUES (${userId}, ${kind}, ${JSON.stringify(detail)}::text::jsonb)
  `;
}

// ---- aircraft profiles ----

export async function listAircraftProfiles(sql: Sql, userId: string) {
  return sql`
    SELECT id, name, performance, limits, created_at
    FROM aircraft_profiles WHERE user_id = ${userId} ORDER BY name
  `;
}

export async function saveAircraftProfile(
  sql: Sql,
  userId: string,
  input: z.infer<typeof aircraftProfileSchema>,
) {
  const [row] = await sql`
    INSERT INTO aircraft_profiles (user_id, name, performance, limits)
    VALUES (${userId}, ${input.name},
            ${JSON.stringify(input.performance)}::text::jsonb,
            ${JSON.stringify(input.limits)}::text::jsonb)
    ON CONFLICT (user_id, name) DO UPDATE SET
      performance = EXCLUDED.performance, limits = EXCLUDED.limits
    RETURNING id
  `;
  await audit(sql, userId, "profile.aircraft.save", { name: input.name });
  return row!.id as string;
}

export async function deleteAircraftProfile(sql: Sql, userId: string, id: string) {
  const rows = await sql`
    DELETE FROM aircraft_profiles WHERE user_id = ${userId} AND id = ${id} RETURNING id
  `;
  if (rows.length > 0) await audit(sql, userId, "profile.aircraft.delete", { id });
  return rows.length > 0;
}

// ---- minimums profiles ----

export async function listMinimumsProfiles(sql: Sql, userId: string) {
  return sql`
    SELECT id, name, minimums, created_at
    FROM minimums_profiles WHERE user_id = ${userId} ORDER BY name
  `;
}

export async function saveMinimumsProfile(
  sql: Sql,
  userId: string,
  input: z.infer<typeof minimumsProfileSchema>,
) {
  const [row] = await sql`
    INSERT INTO minimums_profiles (user_id, name, minimums)
    VALUES (${userId}, ${input.name}, ${JSON.stringify(input.minimums)}::text::jsonb)
    ON CONFLICT (user_id, name) DO UPDATE SET minimums = EXCLUDED.minimums
    RETURNING id
  `;
  await audit(sql, userId, "profile.minimums.save", { name: input.name });
  return row!.id as string;
}

export async function deleteMinimumsProfile(sql: Sql, userId: string, id: string) {
  const rows = await sql`
    DELETE FROM minimums_profiles WHERE user_id = ${userId} AND id = ${id} RETURNING id
  `;
  if (rows.length > 0) await audit(sql, userId, "profile.minimums.delete", { id });
  return rows.length > 0;
}

// ---- flight plans ----

export async function listFlightPlans(sql: Sql, userId: string) {
  return sql`
    SELECT id, name, request, created_at
    FROM flight_plans WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
}

export async function saveFlightPlan(
  sql: Sql,
  userId: string,
  input: z.infer<typeof flightPlanSchema>,
) {
  const [row] = await sql`
    INSERT INTO flight_plans (user_id, name, request)
    VALUES (${userId}, ${input.name}, ${JSON.stringify(input.request)}::text::jsonb)
    ON CONFLICT (user_id, name) DO UPDATE SET request = EXCLUDED.request
    RETURNING id
  `;
  await audit(sql, userId, "plan.save", { name: input.name });
  return row!.id as string;
}

export async function deleteFlightPlan(sql: Sql, userId: string, id: string) {
  const rows = await sql`
    DELETE FROM flight_plans WHERE user_id = ${userId} AND id = ${id} RETURNING id
  `;
  if (rows.length > 0) await audit(sql, userId, "plan.delete", { id });
  return rows.length > 0;
}

// ---- briefings (user-scoped reads) ----

export async function listBriefings(sql: Sql, userId: string, limit = 30) {
  return sql`
    SELECT b.id, b.created_at, b.status, b.trip_summary,
           b.request->'waypoints' AS waypoints
    FROM briefing_snapshots b
    WHERE b.user_id = ${userId}
    ORDER BY b.created_at DESC
    LIMIT ${limit}
  `;
}

export async function userOwnsSnapshot(sql: Sql, userId: string, snapshotId: string) {
  const [row] = await sql`
    SELECT 1 AS ok FROM briefing_snapshots
    WHERE id = ${snapshotId} AND user_id = ${userId}
  `;
  return Boolean(row);
}

// ---- account deletion ----

/** Hard delete: user row cascades to profiles, plans, briefings (which
 *  cascade to assessments/evaluations/links/conversations). Shared weather
 *  source_records are intentionally untouched. */
export async function deleteAccount(sql: Sql, userId: string) {
  await audit(sql, null, "account.delete", { userId });
  await sql`DELETE FROM users WHERE id = ${userId}`;
}
