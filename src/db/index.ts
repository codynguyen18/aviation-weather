import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

// A single connection pool for the whole (long-running) server process.
// `max: 5` is plenty at MVP scale and stays well under Postgres defaults.
const client = postgres(env().DATABASE_URL, { max: 5 });

export const db = drizzle(client);
export const sql = client;
