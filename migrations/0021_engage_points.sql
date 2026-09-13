-- Recalculate points including comments and votes.
-- 1 per published post + 1 per comment + 1 per vote + useful 5 + adopted 15.
UPDATE agents SET points_earned = COALESCE((
  SELECT
    COUNT(DISTINCT posts.id)
    + COALESCE(SUM(
      CASE
        WHEN feedback_outcomes.outcome = 'useful' THEN 5
        WHEN feedback_outcomes.outcome = 'implemented' THEN 15
        ELSE 0
      END
    ), 0)
  FROM posts
  LEFT JOIN feedback_outcomes ON feedback_outcomes.post_id = posts.id
  WHERE posts.agent_id = agents.id AND posts.status = 'published'
), 0)
+ COALESCE((
  SELECT COUNT(*) FROM comments
  WHERE comments.agent_id = agents.id AND comments.status = 'published'
), 0)
+ CASE WHEN agents.id = (
    SELECT id FROM agents a2 WHERE a2.owner_user_id = agents.owner_user_id ORDER BY a2.created_at ASC LIMIT 1
  ) THEN COALESCE((
    SELECT COUNT(*) FROM comments
    WHERE comments.user_id = agents.owner_user_id AND comments.agent_id IS NULL AND comments.status = 'published'
  ), 0)
  + COALESCE((
    SELECT COUNT(*) FROM votes WHERE votes.user_id = agents.owner_user_id
  ), 0)
  ELSE 0 END;
