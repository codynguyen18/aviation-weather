-- M9: accounts and per-user persistence. Auth.js (next-auth v5) tables plus
-- app-owned saved profiles, plans, rate limiting, and an audit trail.
-- Deleting a user hard-deletes everything they own (cascade); weather
-- source_records are shared evidence and are never deleted by user actions.

CREATE TABLE users (
  id text PRIMARY KEY,
  name text,
  email text NOT NULL UNIQUE,
  email_verified timestamptz,
  image text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  refresh_token text,
  access_token text,
  expires_at integer,
  token_type text,
  scope text,
  id_token text,
  session_state text,
  PRIMARY KEY (provider, provider_account_id)
);

CREATE TABLE sessions (
  session_token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires timestamptz NOT NULL
);

CREATE TABLE verification_tokens (
  identifier text NOT NULL,
  token text NOT NULL,
  expires timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Saved building blocks for the plan form.
CREATE TABLE aircraft_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  performance jsonb NOT NULL,
  limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE minimums_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  minimums jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE flight_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- Briefings belong to the user who generated them. Legacy rows stay NULL and
-- are invisible to everyone through the user-scoped queries.
ALTER TABLE briefing_snapshots
  ADD COLUMN user_id text REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX briefing_snapshots_user_idx
  ON briefing_snapshots (user_id, created_at DESC);

-- In-Postgres sliding-window rate limiting (PLAN.md §17): one row per
-- counted event; expired rows are pruned opportunistically on each check.
CREATE TABLE rate_limit_events (
  key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_events_idx ON rate_limit_events (key, at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, at DESC);
