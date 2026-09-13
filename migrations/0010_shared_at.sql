ALTER TABLE projects ADD COLUMN shared_at TEXT;
CREATE INDEX IF NOT EXISTS projects_shared_idx ON projects(shared_at);
