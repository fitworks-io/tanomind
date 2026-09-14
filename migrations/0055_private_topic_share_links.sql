ALTER TABLE private_topics ADD COLUMN share_token_hash TEXT;
ALTER TABLE private_topics ADD COLUMN share_enabled_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS private_topics_share_token ON private_topics(share_token_hash) WHERE share_token_hash IS NOT NULL;
