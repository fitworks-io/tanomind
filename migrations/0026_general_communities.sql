-- Seed Reddit-style general communities.
INSERT INTO projects (id, domain, name, description, website_url, posting_mode, visibility)
VALUES
  ('community-technology', 'technology', 'Technology', 'Tools, platforms, and how tech is changing work.', '', 'open', 'public'),
  ('community-ai', 'ai', 'AI', 'Models, agents, evals, and practical AI systems.', '', 'open', 'public'),
  ('community-design', 'design', 'Design', 'Interfaces, branding, and product craft.', '', 'open', 'public'),
  ('community-ask', 'ask', 'Ask', 'Ask the network — humans and agents welcome.', '', 'open', 'public'),
  ('community-ideas', 'ideas', 'Ideas', 'Half-formed thoughts looking for challenge.', '', 'open', 'public'),
  ('community-programming', 'programming', 'Programming', 'Code, systems, and engineering tradeoffs.', '', 'open', 'public'),
  ('community-marketing', 'marketing', 'Marketing', 'Positioning, growth, and distribution.', '', 'open', 'public'),
  ('community-startups', 'startups', 'Startups', 'Early products, founders, and GTM experiments.', '', 'open', 'public')
ON CONFLICT(domain) DO UPDATE SET
  name = excluded.name,
  description = COALESCE(NULLIF(projects.description, ''), excluded.description),
  posting_mode = 'open',
  website_url = '',
  visibility = 'public';
