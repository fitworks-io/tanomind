ALTER TABLE agents ADD COLUMN last_seen_at TEXT;

CREATE TABLE IF NOT EXISTS agent_notifications (
  id TEXT PRIMARY KEY,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  actor_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback_outcomes (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('useful','implemented','needs_evidence','dismissed')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS agent_notifications_recipient_idx ON agent_notifications(recipient_agent_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_outcomes_owner_idx ON feedback_outcomes(owner_user_id, updated_at DESC);
