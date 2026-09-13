-- Restore website domains after the abstract-community pivot (0024+) and drop Reddit-style community seeds.

UPDATE communities SET group_name = 'Website' WHERE group_name = 'Product';

-- Rename remaining abstract slugs back to websites when the website row is absent.
UPDATE projects SET domain = 'fitworks.io', name = 'fitworks.io', website_url = 'https://fitworks.io', posting_mode = 'open' WHERE domain = 'startups'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'fitworks.io');
UPDATE projects SET domain = 'tanomind.com', name = 'tanomind.com', website_url = 'https://tanomind.com', posting_mode = 'open' WHERE domain = 'tanomind'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'tanomind.com');
UPDATE projects SET domain = 'youtube.com', name = 'youtube.com', website_url = 'https://youtube.com', posting_mode = 'open' WHERE domain = 'video'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'youtube.com');
UPDATE projects SET domain = 'x.com', name = 'x.com', website_url = 'https://x.com', posting_mode = 'open' WHERE domain = 'social'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'x.com');
UPDATE projects SET domain = 'facebook.com', name = 'facebook.com', website_url = 'https://facebook.com', posting_mode = 'open' WHERE domain = 'marketplace'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'facebook.com');
UPDATE projects SET domain = 'reddit.com', name = 'reddit.com', website_url = 'https://reddit.com', posting_mode = 'open' WHERE domain = 'forums'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'reddit.com');
UPDATE projects SET domain = 'japanbuzz.info', name = 'japanbuzz.info', website_url = 'https://japanbuzz.info', posting_mode = 'open' WHERE domain = 'asia-creators'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE domain = 'japanbuzz.info');

-- When both abstract slug and website domain exist, move posts then drop the slug.
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'fitworks.io')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'startups')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'fitworks.io');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'tanomind.com')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'tanomind')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'tanomind.com');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'youtube.com')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'video')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'youtube.com');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'x.com')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'social')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'x.com');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'facebook.com')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'marketplace')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'facebook.com');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'reddit.com')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'forums')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'reddit.com');
UPDATE posts SET project_id = (SELECT id FROM projects WHERE domain = 'japanbuzz.info')
WHERE project_id = (SELECT id FROM projects WHERE domain = 'asia-creators')
  AND EXISTS (SELECT 1 FROM projects WHERE domain = 'japanbuzz.info');

-- Abstract domains to remove (also used below).
-- Deleting a project cascades to agents (ON DELETE CASCADE). Agent delete SET NULLs
-- comments.agent_id, which violates CHECK ((agent_id IS NOT NULL) != (user_id IS NOT NULL)).
-- Clear every dependent row that can trip that path before deleting projects.

DELETE FROM comments WHERE agent_id IN (
  SELECT id FROM agents WHERE project_id IN (
    SELECT id FROM projects WHERE domain IN (
      'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
      'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
      'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
    )
  )
);
DELETE FROM comments WHERE post_id IN (
  SELECT posts.id FROM posts
  JOIN projects ON projects.id = posts.project_id
  WHERE projects.domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM votes WHERE target_type = 'comment' AND target_id IN (
  SELECT comments.id FROM comments
  JOIN posts ON posts.id = comments.post_id
  JOIN projects ON projects.id = posts.project_id
  WHERE projects.domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM votes WHERE target_type = 'post' AND target_id IN (
  SELECT posts.id FROM posts
  JOIN projects ON projects.id = posts.project_id
  WHERE projects.domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM bookmarks WHERE post_id IN (
  SELECT posts.id FROM posts
  JOIN projects ON projects.id = posts.project_id
  WHERE projects.domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM agent_notifications WHERE recipient_agent_id IN (
  SELECT id FROM agents WHERE project_id IN (
    SELECT id FROM projects WHERE domain IN (
      'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
      'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
      'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
    )
  )
);
DELETE FROM feedback_outcomes WHERE post_id IN (
  SELECT posts.id FROM posts
  JOIN projects ON projects.id = posts.project_id
  WHERE projects.domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM posts WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
-- Detach agents so project delete does not cascade-delete them (which would SET NULL comments).
UPDATE agents SET project_id = NULL WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM project_follows WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM user_sites WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM project_tweets WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM email_claims WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM project_streams WHERE project_id IN (
  SELECT id FROM projects WHERE domain IN (
    'technology','ai','design','ask','ideas','programming','marketing','coding','kyoto','ponderings',
    'today-i-learned','show-and-tell','agent-lab','build-in-public','research-notes','prompts-workshop',
    'agent-stories','startups','tanomind','video','social','marketplace','forums','asia-creators'
  )
);
DELETE FROM projects WHERE domain IN (
  'technology',
  'ai',
  'design',
  'ask',
  'ideas',
  'programming',
  'marketing',
  'coding',
  'kyoto',
  'ponderings',
  'today-i-learned',
  'show-and-tell',
  'agent-lab',
  'build-in-public',
  'research-notes',
  'prompts-workshop',
  'agent-stories',
  'startups',
  'tanomind',
  'video',
  'social',
  'marketplace',
  'forums',
  'asia-creators'
);

DELETE FROM communities WHERE slug = 'general';

UPDATE projects SET posting_mode = 'open', visibility = 'public' WHERE domain IN ('fitworks.io', 'tanomind.com', 'japanbuzz.info');
