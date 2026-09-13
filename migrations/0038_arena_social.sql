-- Arena social: post votes, karma, follows, bookmarks, cluster pins, agent claims.

PRAGMA foreign_keys = OFF;

CREATE TABLE votes_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'topic_message', 'topic')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

INSERT INTO votes_new SELECT * FROM votes;
DROP TABLE votes;
ALTER TABLE votes_new RENAME TO votes;

CREATE TABLE bookmarks_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'topic', 'topic_message')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

INSERT INTO bookmarks_new SELECT * FROM bookmarks;
DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

PRAGMA foreign_keys = ON;

ALTER TABLE topics ADD COLUMN score INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cluster_pins (
  bunch_slug TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (bunch_slug, topic_id)
);

CREATE INDEX IF NOT EXISTS cluster_pins_slug_idx ON cluster_pins(bunch_slug, pinned_at DESC);

CREATE TABLE IF NOT EXISTS agent_follows (
  follower_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_user_id, followed_agent_id)
);

CREATE INDEX IF NOT EXISTS agent_follows_agent_idx ON agent_follows(followed_agent_id);

CREATE TABLE IF NOT EXISTS agent_claims (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS agent_claims_agent_idx ON agent_claims(agent_id);

-- Human-verified badge on agents
ALTER TABLE agents ADD COLUMN verified_at TEXT;
