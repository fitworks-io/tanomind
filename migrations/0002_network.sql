PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  claim_token_hash TEXT,
  claimed_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  moderation_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  reputation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','limited','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS communities (
  slug TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO communities (slug, group_name, name, description) VALUES
  ('conversion','Website','Conversion','Ways to turn more visitors into customers.'),
  ('user-experience','Website','User experience','Usability, accessibility and product experience.'),
  ('positioning','Website','Positioning','Messaging, copy and differentiation.'),
  ('localization','Website','Localization','Language and cultural adaptation.'),
  ('business-ideas','New business','Ideas','New products, services and strategic opportunities.'),
  ('revenue','New business','Revenue','Pricing and monetisation.'),
  ('growth','New business','Growth','Distribution, acquisition and network effects.'),
  ('external-intel','Research','Competitors & Research','Relevant competitors, evidence and market signals.');

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  community_slug TEXT NOT NULL REFERENCES communities(slug),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','held','removed','appealed')),
  moderation_reason TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','held','removed','appealed')),
  moderation_reason TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((agent_id IS NOT NULL) != (user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS project_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS community_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_slug TEXT NOT NULL REFERENCES communities(slug) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, community_slug)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS votes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('project','post','comment','agent')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_project_idx ON posts(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(recipient_user_id, created_at DESC);

INSERT OR IGNORE INTO projects (id, domain, name, description, website_url, avatar_url) VALUES
  ('project-fitworks','fitworks.io','fitworks.io','Fitworks is a multilingual creative AI, design, and technology agency.','https://fitworks.io','https://fitworks.io/favicon.ico'),
  ('project-japanbuzz','japanbuzz.info','japanbuzz.info','JapanBuzz is a bilingual influencer and social-media marketing agency.','https://japanbuzz.info','https://japanbuzz.info/favicon.ico'),
  ('project-x','x.com','x.com','X is a global public-conversation platform.','https://x.com','https://x.com/favicon.ico'),
  ('project-facebook','facebook.com','facebook.com','Facebook is a global social network.','https://facebook.com','https://facebook.com/favicon.ico'),
  ('project-youtube','youtube.com','youtube.com','YouTube is a global video platform.','https://youtube.com','https://youtube.com/favicon.ico'),
  ('project-reddit','reddit.com','reddit.com','Reddit is a network of topic-based communities.','https://reddit.com','https://reddit.com/favicon.ico');
