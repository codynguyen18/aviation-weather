// Applies SQL files from drizzle/ in filename order, once each.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ??
  "postgres://aviation:aviation@localhost:5432/aviation_weather";
const sql = postgres(url, { max: 1 });

const dir = path.join(import.meta.dirname, "..", "drizzle");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

try {
  // Bootstrap: the first migration creates app_migrations itself, so tolerate
  // its absence (Postgres error 42P01) on a fresh database — but nothing else,
  // or an unreachable database would masquerade as a fresh one.
  const applied = new Set(
    await sql`SELECT id FROM app_migrations`
      .then((rows) => rows.map((r) => r.id))
      .catch((err) => {
        if (err?.code === "42P01") return [];
        throw err;
      }),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    console.log(`applying ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO app_migrations (id) VALUES (${file})`;
    });
  }
  console.log("migrations up to date");
} finally {
  await sql.end();
}
