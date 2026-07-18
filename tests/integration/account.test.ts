import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aircraftProfileSchema,
  deleteAccount,
  deleteFlightPlan,
  flightPlanSchema,
  listAircraftProfiles,
  listBriefings,
  listFlightPlans,
  minimumsProfileSchema,
  saveAircraftProfile,
  saveFlightPlan,
  saveMinimumsProfile,
  userOwnsSnapshot,
} from "@/lib/account/store";
import { checkRateLimit } from "@/lib/account/rate-limit";

// M9 acceptance (PLAN.md §21): two-user isolation at the query layer, hard
// account deletion cascading through everything user-owned, and the
// in-Postgres sliding-window rate limiter.

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

const U1 = "test-user-1";
const U2 = "test-user-2";

const PERFORMANCE = {
  cruiseTasKt: 165, climbRateFpm: 900, climbTasKt: 130,
  descentRateFpm: 500, descentTasKt: 140,
};

async function insertFakeSnapshot(userId: string): Promise<string> {
  const [row] = await sql!`
    INSERT INTO briefing_snapshots
      (ruleset_version, engine_version, status, partial_reasons, request,
       route, refresh_summary, trip_summary, user_id)
    VALUES
      ('1.0.0', 'test', 'complete', '[]'::jsonb,
       '{"waypoints":[{"ident":"KSTL"},{"ident":"KOAK"}]}'::jsonb,
       '{"segments":[],"waypoints":[]}'::jsonb, '{}'::jsonb,
       '{"worstRating":"green","counts":{"green":1,"yellow":0,"red":0,"unknown":0},"hardStops":[]}'::jsonb,
       ${userId})
    RETURNING id
  `;
  return row!.id as string;
}

describe.skipIf(!sql)("accounts: isolation, deletion, rate limits", () => {
  beforeAll(async () => {
    await sql!`DELETE FROM users WHERE id IN (${U1}, ${U2})`;
    await sql!`DELETE FROM rate_limit_events WHERE key LIKE 'test:%'`;
    await sql!`
      INSERT INTO users (id, email) VALUES
        (${U1}, 'test-user-1@example.com'),
        (${U2}, 'test-user-2@example.com')
    `;
  });

  afterAll(async () => {
    await sql!`DELETE FROM users WHERE id IN (${U1}, ${U2})`;
    await sql!`DELETE FROM rate_limit_events WHERE key LIKE 'test:%'`;
    await sql!`DELETE FROM audit_events WHERE user_id IN (${U1}, ${U2})
      OR detail->>'userId' IN (${U1}, ${U2})`;
    await sql!.end();
  });

  it("saved profiles and plans are scoped per user", async () => {
    await saveAircraftProfile(sql!, U1, aircraftProfileSchema.parse({
      name: "N12345 Bonanza",
      performance: PERFORMANCE,
      limits: { fuelEnduranceMin: 300 },
    }));
    await saveMinimumsProfile(sql!, U1, minimumsProfileSchema.parse({
      name: "IFR personal", minimums: { nightOk: true },
    }));
    await saveFlightPlan(sql!, U1, flightPlanSchema.parse({
      name: "STL to Oakland",
      request: {
        waypoints: [{ ident: "KSTL" }, { ident: "KOAK" }],
        departureTimeUtc: "2026-07-18T04:30:00Z",
        cruiseAltitudeFt: 10500,
        performance: PERFORMANCE,
        minimums: {},
        aircraft: { fuelEnduranceMin: 600 },
      },
    }));

    expect(await listAircraftProfiles(sql!, U1)).toHaveLength(1);
    expect(await listFlightPlans(sql!, U1)).toHaveLength(1);
    // The other user sees none of it.
    expect(await listAircraftProfiles(sql!, U2)).toHaveLength(0);
    expect(await listFlightPlans(sql!, U2)).toHaveLength(0);
  });

  it("upsert by (user, name) updates instead of duplicating", async () => {
    await saveAircraftProfile(sql!, U1, aircraftProfileSchema.parse({
      name: "N12345 Bonanza",
      performance: { ...PERFORMANCE, cruiseTasKt: 170 },
      limits: { fuelEnduranceMin: 330 },
    }));
    const rows = await listAircraftProfiles(sql!, U1);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.performance as { cruiseTasKt: number }).cruiseTasKt).toBe(170);
  });

  it("cross-user delete is a no-op", async () => {
    const [plan] = await listFlightPlans(sql!, U1);
    expect(await deleteFlightPlan(sql!, U2, plan!.id as string)).toBe(false);
    expect(await listFlightPlans(sql!, U1)).toHaveLength(1);
  });

  it("briefings are user-scoped, including ownership checks", async () => {
    const s1 = await insertFakeSnapshot(U1);
    const s2 = await insertFakeSnapshot(U2);
    expect((await listBriefings(sql!, U1)).map((r) => r.id)).toEqual([s1]);
    expect((await listBriefings(sql!, U2)).map((r) => r.id)).toEqual([s2]);
    expect(await userOwnsSnapshot(sql!, U1, s1)).toBe(true);
    expect(await userOwnsSnapshot(sql!, U1, s2)).toBe(false);
  });

  it("sliding-window rate limit blocks after N and recovers keys independently", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(sql!, "test:a", 3, 60)).allowed).toBe(true);
    }
    const denied = await checkRateLimit(sql!, "test:a", 3, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMin).toBeGreaterThan(0);
    // A different key (other user / other action) is unaffected.
    expect((await checkRateLimit(sql!, "test:b", 3, 60)).allowed).toBe(true);
  });

  it("account deletion cascades to everything owned, leaves shared data", async () => {
    // Give user 1 a conversation hanging off their snapshot.
    const [snap] = await sql!`
      SELECT id FROM briefing_snapshots WHERE user_id = ${U1} LIMIT 1
    `;
    const [conv] = await sql!`
      INSERT INTO conversations (snapshot_id) VALUES (${snap!.id}) RETURNING id
    `;
    await sql!`
      INSERT INTO conversation_messages (conversation_id, seq, role, content)
      VALUES (${conv!.id}, 1, 'user', 'hello')
    `;

    await deleteAccount(sql!, U1);

    expect(await sql!`SELECT 1 FROM users WHERE id = ${U1}`).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM aircraft_profiles WHERE user_id = ${U1}`).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM minimums_profiles WHERE user_id = ${U1}`).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM flight_plans WHERE user_id = ${U1}`).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM briefing_snapshots WHERE user_id = ${U1}`).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM conversations WHERE id = ${conv!.id}`).toHaveLength(0);
    // The audit trail records the deletion (without keeping the user row).
    const auditRows = await sql!`
      SELECT 1 FROM audit_events WHERE kind = 'account.delete'
        AND detail->>'userId' = ${U1}
    `;
    expect(auditRows.length).toBeGreaterThan(0);
    // The other user's world is intact.
    expect(await sql!`SELECT 1 FROM users WHERE id = ${U2}`).toHaveLength(1);
    expect(await sql!`SELECT 1 FROM briefing_snapshots WHERE user_id = ${U2}`).toHaveLength(1);
  });
});
