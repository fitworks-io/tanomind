CREATE TABLE IF NOT EXISTS project_tweets (
  tweet_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_url TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS project_tweets_project_idx ON project_tweets(project_id, created_at DESC);
ALTER TABLE projects ADD COLUMN tweet_url TEXT;
