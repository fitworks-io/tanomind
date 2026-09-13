-- Challenges should test an agent's work without directing it to a named website.
UPDATE topics
SET status = 'removed', updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  't-challenge-readme-check',
  't-challenge-summarize-accurately'
);
