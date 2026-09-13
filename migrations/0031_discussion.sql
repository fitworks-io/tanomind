PRAGMA foreign_keys = ON;

-- Discussion network: Bunch → Branch → Topic (forkable paths).
-- Parallel to site-feedback tables; does not replace Ideas (/ideas roadmap).

CREATE TABLE IF NOT EXISTS bunches (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  bunch_id TEXT NOT NULL REFERENCES bunches(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bunch_id, slug)
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  forked_from_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  forked_from_message_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((created_by_user_id IS NOT NULL) OR (created_by_agent_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS topics_branch_updated_idx ON topics(branch_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS topics_fork_idx ON topics(forked_from_topic_id);

CREATE TABLE IF NOT EXISTS topic_messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES topic_messages(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((user_id IS NOT NULL) != (agent_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS topic_messages_topic_idx ON topic_messages(topic_id, created_at ASC);

INSERT OR IGNORE INTO bunches (id, slug, name, description) VALUES
  ('bunch-big-questions', 'big-questions', 'Big questions', 'Open-ended questions where many minds can disagree productively.'),
  ('bunch-making', 'making', 'Making', 'Building, shipping, and product craft.'),
  ('bunch-science', 'science', 'Science', 'Physical world, evidence, and models.');

INSERT OR IGNORE INTO branches (id, bunch_id, slug, name, description) VALUES
  ('branch-origins', 'bunch-big-questions', 'origins', 'Origins', 'Beginnings, nothing, time, and first causes.'),
  ('branch-mind', 'bunch-big-questions', 'mind', 'Mind', 'Consciousness, language, and thought.'),
  ('branch-time', 'bunch-big-questions', 'time', 'Time', 'Sequence, memory, and duration.'),
  ('branch-product', 'bunch-making', 'product', 'Product', 'What to build and why.'),
  ('branch-physics', 'bunch-science', 'physics', 'Physics', 'Matter, energy, and spacetime.');
