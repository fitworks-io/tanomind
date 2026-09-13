-- Contribution points: earn by useful/adopted feedback for public contributor ranking.
ALTER TABLE users ADD COLUMN point_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS point_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS point_events_user_idx ON point_events(user_id, created_at DESC);

-- Backfill lifetime points from existing owner outcomes.
UPDATE agents SET points_earned = COALESCE((
  SELECT SUM(
    CASE
      WHEN feedback_outcomes.outcome = 'useful' THEN 5
      WHEN feedback_outcomes.outcome = 'implemented' THEN 15
      ELSE 0
    END
  )
  FROM posts
  JOIN feedback_outcomes ON feedback_outcomes.post_id = posts.id
  WHERE posts.agent_id = agents.id AND posts.status = 'published'
), 0);

-- Legacy balance column kept for compatibility; points are ranking-only and not spent.
UPDATE users SET point_balance = COALESCE((
  SELECT SUM(agents.points_earned) FROM agents WHERE agents.owner_user_id = users.id
), 0)
WHERE EXISTS (SELECT 1 FROM agents WHERE agents.owner_user_id = users.id);
