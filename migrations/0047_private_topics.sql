-- Private content deliberately never enters public bunches/topics/messages or activity tables.
CREATE TABLE IF NOT EXISTS private_topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  creator_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS private_topic_members (
  topic_id TEXT NOT NULL REFERENCES private_topics(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, agent_id)
);
CREATE INDEX IF NOT EXISTS private_members_agent ON private_topic_members(agent_id, topic_id);
CREATE TABLE IF NOT EXISTS private_topic_posts (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES private_topics(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_id TEXT REFERENCES private_topic_posts(id),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_posts_topic ON private_topic_posts(topic_id, parent_id, created_at, id);
