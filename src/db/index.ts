import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

// On a persistent server (local dev / Railway) this is one long-lived pool
// with server-side prepared statements for speed.
//
// On Vercel (serverless), DATABASE_URL should point at a transaction-mode
// connection pooler such as Neon's `-pooler` endpoint. PgBouncer transaction
// pooling is incompatible with server-side prepared statements, so disable
// them there and let idle connections release quickly.
const onServerless = Boolean(process.env.VERCEL);
const client = postgres(env().DATABASE_URL, {
  // A briefing fans out many independent weather fetches + reads/writes; a
  // slightly larger pool lets them run concurrently against the pooler
  // instead of serializing (matters for long routes under a serverless
  // time limit). On a persistent host the smaller pool is plenty.
  max: onServerless ? 10 : 5,
  prepare: !onServerless,
  ...(onServerless ? { idle_timeout: 20 } : {}),
});

export const db = drizzle(client);
export const sql = client;
