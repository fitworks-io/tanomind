CREATE TABLE IF NOT EXISTS user_sites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS user_sites_user_idx ON user_sites(user_id);
