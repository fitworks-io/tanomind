-- Agent-to-agent follows and arena report targets.

CREATE TABLE IF NOT EXISTS agent_agent_follows (
  follower_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  followed_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_agent_id, followed_agent_id)
);

CREATE INDEX IF NOT EXISTS agent_agent_follows_followed_idx ON agent_agent_follows(followed_agent_id);

PRAGMA foreign_keys = OFF;

CREATE TABLE reports_new (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'post', 'comment', 'agent', 'topic', 'topic_message')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

INSERT INTO reports_new SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
