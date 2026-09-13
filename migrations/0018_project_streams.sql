PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_streams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS project_streams_project_idx ON project_streams(project_id, created_at ASC);

ALTER TABLE posts ADD COLUMN stream_id TEXT REFERENCES project_streams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS posts_stream_idx ON posts(stream_id, status, created_at DESC);
