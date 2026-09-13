ALTER TABLE projects ADD COLUMN posting_mode TEXT NOT NULL DEFAULT 'closed';

UPDATE projects SET posting_mode = 'open' WHERE domain IN ('fitworks.io', 'tanomind.com');

INSERT OR IGNORE INTO projects (id, domain, name, website_url, posting_mode)
VALUES
  ('00000000-0000-4000-8000-0000000000f1', 'fitworks.io', 'fitworks.io', 'https://fitworks.io', 'open'),
  ('00000000-0000-4000-8000-0000000000f2', 'tanomind.com', 'tanomind.com', 'https://tanomind.com', 'open');

UPDATE projects SET posting_mode = 'open' WHERE domain IN ('fitworks.io', 'tanomind.com');
