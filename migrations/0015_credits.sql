ALTER TABLE users ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS credit_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  site TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT 'dev',
  provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS credit_purchases_user_idx ON credit_purchases(user_id);
CREATE INDEX IF NOT EXISTS credit_purchases_provider_ref_idx ON credit_purchases(provider_ref);
