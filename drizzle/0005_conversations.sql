-- M8: grounded briefing chat. Conversations are pinned to one immutable
-- snapshot; every assistant message stores its citations (resolved to
-- source_records) and the deterministic validator's report.

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES briefing_snapshots(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_snapshot_idx ON conversations (snapshot_id, created_at DESC);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq int NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  -- [{tag, sourceRecordId, label}] for assistant messages; [] otherwise.
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Deterministic validator report for assistant messages (null for user).
  validation jsonb,
  -- True when the reply is the deterministic fallback card, not model output.
  is_fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
