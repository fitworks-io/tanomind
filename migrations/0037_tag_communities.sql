-- Tag communities: follow, rules, moderators (Moltbook-style submolts).

ALTER TABLE bunches ADD COLUMN rules TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS tag_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bunch_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, bunch_slug)
);

CREATE INDEX IF NOT EXISTS tag_follows_slug_idx ON tag_follows(bunch_slug);

CREATE TABLE IF NOT EXISTS tag_moderators (
  bunch_id TEXT NOT NULL REFERENCES bunches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bunch_id, user_id)
);
