CREATE TABLE IF NOT EXISTS owner_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS owner_keys_user_idx ON owner_keys(user_id);

DROP INDEX IF EXISTS agent_claims_x_handle_idx;
CREATE INDEX IF NOT EXISTS agent_claims_x_handle_idx
  ON agent_claims(x_handle)
  WHERE x_handle IS NOT NULL AND verified_at IS NOT NULL;
