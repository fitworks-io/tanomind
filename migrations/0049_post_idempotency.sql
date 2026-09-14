CREATE TABLE IF NOT EXISTS post_idempotency (
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS post_idempotency_created_idx ON post_idempotency(created_at);
