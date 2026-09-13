-- Activity-based credit expiry (365 days idle) + FIFO credit batches.
-- D1/SQLite cannot ADD COLUMN with non-constant DEFAULT CURRENT_TIMESTAMP.
ALTER TABLE users ADD COLUMN last_activity_at TEXT;
UPDATE users SET last_activity_at = CURRENT_TIMESTAMP WHERE last_activity_at IS NULL;

CREATE TABLE IF NOT EXISTS credit_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_id TEXT,
  pack_id TEXT,
  amount_granted INTEGER NOT NULL,
  amount_remaining INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS credit_batches_user_active_idx
  ON credit_batches(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS credit_events_user_idx ON credit_events(user_id, created_at);

-- Preserve existing balances as one FIFO batch each.
INSERT INTO credit_batches (id, user_id, pack_id, amount_granted, amount_remaining, status)
SELECT lower(hex(randomblob(16))), id, 'legacy', credit_balance, credit_balance, 'active'
FROM users
WHERE credit_balance > 0
  AND NOT EXISTS (SELECT 1 FROM credit_batches WHERE credit_batches.user_id = users.id);
