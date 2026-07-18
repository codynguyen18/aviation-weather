-- 0004_briefings: immutable briefing snapshots with full provenance
-- (PLAN.md §13.4). A snapshot pins the exact route model, inputs, rule
-- results, and source records used — it re-renders identically forever.

CREATE TABLE briefing_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ruleset_version text NOT NULL,
  engine_version  text NOT NULL,
  status          text NOT NULL,          -- complete | partial
  partial_reasons jsonb NOT NULL DEFAULT '[]',
  request         jsonb NOT NULL,         -- validated briefing request (route+minimums+aircraft)
  route           jsonb NOT NULL,         -- full RouteModel as computed
  refresh_summary jsonb NOT NULL,         -- per-product tri-state fetch summary
  trip_summary    jsonb NOT NULL          -- worst rating, counts, hard stops
);

CREATE INDEX briefing_snapshots_created ON briefing_snapshots (created_at DESC);

CREATE TABLE rule_evaluations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL REFERENCES briefing_snapshots(id) ON DELETE CASCADE,
  segment_seq   integer NOT NULL,
  rule_id       text NOT NULL,
  rule_version  integer NOT NULL,
  rule_class    text NOT NULL,            -- hard-limit | advisory
  result        text NOT NULL,            -- pass | yellow | red | unknown | not-applicable
  measured      jsonb NOT NULL DEFAULT '{}',
  thresholds    jsonb NOT NULL DEFAULT '{}',
  confidence    text NOT NULL,            -- high | medium | low
  explanation   text NOT NULL,
  is_hard_stop  boolean NOT NULL DEFAULT false,
  source_record_ids jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX rule_evaluations_snapshot ON rule_evaluations (snapshot_id, segment_seq);

CREATE TABLE segment_assessments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id  uuid NOT NULL REFERENCES briefing_snapshots(id) ON DELETE CASCADE,
  segment_seq  integer NOT NULL,
  rating       text NOT NULL,             -- green | yellow | red | unknown
  confidence   text NOT NULL,
  summary      text NOT NULL,
  hard_stops   jsonb NOT NULL DEFAULT '[]',
  UNIQUE (snapshot_id, segment_seq)
);

CREATE TABLE briefing_source_links (
  snapshot_id      uuid NOT NULL REFERENCES briefing_snapshots(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE RESTRICT,
  role             text NOT NULL,
  PRIMARY KEY (snapshot_id, source_record_id, role)
);
-- RESTRICT: snapshot-linked source records are the briefing's evidence and
-- must survive cache purges (PLAN.md §13.6).
