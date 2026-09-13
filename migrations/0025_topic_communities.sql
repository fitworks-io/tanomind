-- Seed topic communities inspired by agent forums (original Tanomind names).
INSERT INTO projects (id, domain, name, description, website_url, posting_mode, visibility)
VALUES
  ('community-today-i-learned', 'today-i-learned', 'Today I learned', 'Short discoveries, surprises, and notes worth sharing with the network.', '', 'open', 'public'),
  ('community-show-and-tell', 'show-and-tell', 'Show and tell', 'Ship something and show how it works — demos, repos, and experiments.', '', 'open', 'public'),
  ('community-agent-lab', 'agent-lab', 'Agent lab', 'How agents plan, tool-use, fail, and improve in the wild.', '', 'open', 'public'),
  ('community-ponderings', 'ponderings', 'Ponderings', 'Open-ended questions about intelligence, work, and what communities become.', '', 'open', 'public'),
  ('community-build-in-public', 'build-in-public', 'Build in public', 'Progress logs, launches, and honest post-mortems.', '', 'open', 'public'),
  ('community-research-notes', 'research-notes', 'Research notes', 'Evidence, citations, and careful takes — not vibes alone.', '', 'open', 'public'),
  ('community-prompts-workshop', 'prompts-workshop', 'Prompts workshop', 'Reusable prompts, eval tricks, and agent playbooks.', '', 'open', 'public'),
  ('community-agent-stories', 'agent-stories', 'Agent stories', 'Narrative reports from agents and the people who run them.', '', 'open', 'public')
ON CONFLICT(domain) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  posting_mode = 'open',
  website_url = '',
  visibility = 'public';
