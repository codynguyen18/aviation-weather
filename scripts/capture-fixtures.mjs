// Captures one real response per upstream endpoint used by the app
// (PLAN.md §7) into fixtures/upstream/, with a manifest recording where and
// when each came from. Re-run any time with: npm run fixtures:capture
//
// These fixtures let parsers and rules develop/test offline; they are NOT
// live weather and must never be shown to a user as such.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USER_AGENT =
  process.env.UPSTREAM_USER_AGENT ??
  "aviation-weather-planner (fixture capture, unconfigured@example.com)";

const outDir = path.join(import.meta.dirname, "..", "fixtures", "upstream");
await mkdir(outDir, { recursive: true });

/** @type {{name: string, url: string, ext: string}[]} */
const staticTargets = [
  // Aviation Weather Center Data API
  { name: "awc-metar-json", url: "https://aviationweather.gov/api/data/metar?ids=KSTL,KOAK,KRNO&format=json", ext: "json" },
  { name: "awc-metar-raw", url: "https://aviationweather.gov/api/data/metar?ids=KSTL,KOAK,KRNO&format=raw", ext: "txt" },
  { name: "awc-taf-json", url: "https://aviationweather.gov/api/data/taf?ids=KSTL,KOAK,KRNO&format=json", ext: "json" },
  { name: "awc-pirep-json", url: "https://aviationweather.gov/api/data/pirep?bbox=35,-115,45,-90&format=json&age=6", ext: "json" },
  { name: "awc-airsigmet-geojson", url: "https://aviationweather.gov/api/data/airsigmet?format=geojson", ext: "geojson" },
  { name: "awc-gairmet-geojson", url: "https://aviationweather.gov/api/data/gairmet?format=geojson", ext: "geojson" },
  { name: "awc-cwa-geojson", url: "https://aviationweather.gov/api/data/cwa?format=geojson", ext: "geojson" },
  { name: "awc-windtemp-chi-low-06", url: "https://aviationweather.gov/api/data/windtemp?region=chi&level=low&fcst=06", ext: "txt" },
  { name: "awc-windtemp-sfo-low-06", url: "https://aviationweather.gov/api/data/windtemp?region=sfo&level=low&fcst=06", ext: "txt" },
  { name: "awc-stationinfo-json", url: "https://aviationweather.gov/api/data/stationinfo?ids=KSTL,KOAK,KRNO&format=json", ext: "json" },
  { name: "awc-airport-json", url: "https://aviationweather.gov/api/data/airport?ids=KSTL,KOAK&format=json", ext: "json" },
  // National Weather Service API
  { name: "nws-points-reno", url: "https://api.weather.gov/points/39.5,-119.8", ext: "json" },
  { name: "nws-afd-rev-latest", url: "https://api.weather.gov/products/types/AFD/locations/REV/latest", ext: "json" },
  { name: "nws-alerts-nv", url: "https://api.weather.gov/alerts/active?area=NV", ext: "json" },
  // Storm Prediction Center
  { name: "spc-day1-categorical", url: "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson", ext: "geojson" },
];

async function fetchOne(target) {
  const res = await fetch(target.url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
  });
  const body = await res.text();
  const entry = {
    name: target.name,
    url: target.url,
    fetchedAt: new Date().toISOString(),
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    lastModified: res.headers.get("last-modified"),
    bytes: body.length,
  };
  if (res.status >= 200 && res.status < 300 && body.length > 0) {
    await writeFile(path.join(outDir, `${target.name}.${target.ext}`), body);
  } else {
    // 204 (no current data) and errors are recorded in the manifest but write
    // no fixture file — an empty product is itself a state worth knowing.
    entry.note = "no body captured";
  }
  return entry;
}

const manifest = [];
for (const target of staticTargets) {
  try {
    const entry = await fetchOne(target);
    manifest.push(entry);
    console.log(`${entry.status} ${target.name} (${entry.bytes}B)`);
  } catch (err) {
    manifest.push({ name: target.name, url: target.url, error: String(err) });
    console.error(`FAIL ${target.name}: ${err}`);
  }
  // Be polite to government servers: space requests out.
  await new Promise((r) => setTimeout(r, 1500));
}

// The gridpoint forecast URL is discovered from the points response, so fetch
// it dynamically rather than hardcoding office/grid coordinates.
try {
  const points = manifest.find((m) => m.name === "nws-points-reno");
  if (points && points.status === 200) {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(
      await readFile(path.join(outDir, "nws-points-reno.json"), "utf8"),
    );
    const forecastUrl = parsed?.properties?.forecast;
    if (forecastUrl) {
      const entry = await fetchOne({
        name: "nws-gridpoint-forecast-reno",
        url: forecastUrl,
        ext: "json",
      });
      manifest.push(entry);
      console.log(`${entry.status} nws-gridpoint-forecast-reno (${entry.bytes}B)`);
    }
  }
} catch (err) {
  console.error(`FAIL nws-gridpoint-forecast-reno: ${err}`);
}

await writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(`\nwrote ${manifest.length} manifest entries to fixtures/upstream/`);
