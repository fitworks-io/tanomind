-- Recalculate points: 1 per published post + outcome bonuses (useful 5, adopted 15).
UPDATE agents SET points_earned = COALESCE((
  SELECT
    COUNT(DISTINCT posts.id) * 1
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
), 0);
