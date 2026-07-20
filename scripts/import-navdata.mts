// Downloads the OurAirports daily CSV dumps and loads them as a new versioned
// navdata dataset, then atomically activates it.
//
// Usage:
//   npm run navdata:import                # download live files and import
//   npm run navdata:import -- --dir path  # import from local CSV files
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

import { importOurAirports } from "../src/lib/nav/import";

const BASE = "https://davidmegginson.github.io/ourairports-data";
const FILES = ["airports.csv", "runways.csv", "navaids.csv"] as const;

const userAgent =
  process.env.UPSTREAM_USER_AGENT ??
  "aviation-weather-planner (navdata import, unconfigured@example.com)";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aviation:aviation@localhost:5432/aviation_weather";

async function loadSources(): Promise<{ files: string[]; label: string }> {
  const dirFlag = process.argv.indexOf("--dir");
  if (dirFlag !== -1) {
    const dir = process.argv[dirFlag + 1];
    if (!dir) throw new Error("--dir requires a path");
    const files = await Promise.all(
      FILES.map((f) => readFile(path.resolve(dir, f), "utf8")),
    );
    return { files, label: `local-${new Date().toISOString().slice(0, 10)}` };
  }

  const files: string[] = [];
  let label = new Date().toISOString().slice(0, 10);
  for (const f of FILES) {
    const res = await fetch(`${BASE}/${f}`, {
      headers: { "User-Agent": userAgent },
    });
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    files.push(await res.text());
    const lm = res.headers.get("last-modified");
    if (f === "airports.csv" && lm) {
      label = new Date(lm).toISOString().slice(0, 10);
    }
  }
  return { files, label };
}

const { files, label } = await loadSources();
const [airportsCsv, runwaysCsv, navaidsCsv] = files as [string, string, string];

// prepare:false so this works through a transaction-mode pooler (Neon) too.
const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  const result = await importOurAirports(sql, {
    airportsCsv,
    runwaysCsv,
    navaidsCsv,
    versionLabel: label,
  });
  console.log(
    `imported ourairports@${label}: ${result.airports} airports, ` +
      `${result.runways} runways, ${result.navaids} navaids ` +
      `(dataset ${result.datasetId})`,
  );
} finally {
  await sql.end();
}
