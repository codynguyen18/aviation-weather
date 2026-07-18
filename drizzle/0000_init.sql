-- 0000_init: enable PostGIS and create the migration bookkeeping table.
-- PostGIS is the app's authoritative geometry engine (PLAN.md §10): route
-- corridors, hazard-polygon intersections, and proximity queries all run here.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS app_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
