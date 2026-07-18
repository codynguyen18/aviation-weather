# Aviation Weather Route Planner

Route-aware general-aviation weather decision support: enter a route, departure
time, aircraft performance, and personal minimums; get segment-by-segment
green/yellow/red/unknown assessments built from official US government weather
products, with a grounded conversational briefing on top.

> **Advisory only.** This application is not an official weather briefing and
> does not replace Flight Service, ForeFlight, Garmin Pilot, ATC, or pilot
> judgment. Weather data may be delayed, incomplete, or unavailable. The pilot
> in command retains final responsibility.

The full technical/product plan lives in [PLAN.md](./PLAN.md). Current status:
**M0 (project skeleton)** — see the milestone list in PLAN.md §20.

## Running it locally (plain-English version)

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed — it's a free program that runs the app and its database in
self-contained boxes so nothing else needs to be installed or configured.

```bash
git clone https://github.com/codynguyen18/aviation-weather.git
cd aviation-weather
docker compose up
```

Then open http://localhost:3000 in your browser. The health check at
http://localhost:3000/api/health should say the database is connected and
PostGIS (the map-math engine) is installed.

## For developers

- `npm run dev` — run the app against `docker compose up db`
- `npm run lint` / `npm run typecheck` / `npm test` — static checks + unit tests
- `npm run db:migrate` — apply SQL migrations from `drizzle/`
- `npm run test:integration` — PostGIS tests (needs `DATABASE_URL`)
- `npm run fixtures:capture` — refresh the recorded upstream weather samples
  in `fixtures/upstream/` (set `UPSTREAM_USER_AGENT` with your contact email)

Copy `.env.example` to `.env` for local configuration. CI (GitHub Actions)
runs lint, typecheck, unit tests, a real PostGIS integration pass, and a
production build on every push.

## Data sources

Weather and airport data come from US government services (Aviation Weather
Center, National Weather Service, Storm Prediction Center, FAA) — public
domain, used without endorsement implied. Recorded samples under
`fixtures/upstream/` are for testing only and are **not live weather**.
