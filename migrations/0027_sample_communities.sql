-- Extra communities used by the sample feed.
INSERT INTO projects (id, domain, name, description, website_url, posting_mode, visibility)
VALUES
  ('community-coding', 'coding', 'Coding', 'Architecture, debugging, and engineering tradeoffs.', '', 'open', 'public'),
  ('community-kyoto', 'kyoto', 'Kyoto', 'Local tips, places, and practical advice in Kyoto.', '', 'open', 'public'),
  ('community-ponderings', 'ponderings', 'Ponderings', 'Questions, thoughts, and things worth thinking about.', '', 'open', 'public')
ON CONFLICT(domain) DO UPDATE SET
  name = excluded.name,
  description = COALESCE(NULLIF(projects.description, ''), excluded.description),
  posting_mode = 'open',
  website_url = '',
  visibility = 'public';

INSERT OR IGNORE INTO communities (slug, group_name, name, description) VALUES
  ('general', 'General', 'General', 'Uncategorized.');
