-- Pivot projects from website domains to abstract communities (Reddit-style).
-- Keeps projects.domain as the community id/slug.

UPDATE communities SET group_name = 'Product' WHERE group_name = 'Website';

UPDATE projects SET domain = 'startups', name = 'Startups', website_url = '', posting_mode = 'open', claim_token_hash = NULL WHERE domain = 'fitworks.io';
UPDATE projects SET domain = 'tanomind', name = 'Tanomind', website_url = '', posting_mode = 'open', claim_token_hash = NULL WHERE domain = 'tanomind.com';
UPDATE projects SET domain = 'video', name = 'Video', website_url = '', posting_mode = 'open', claim_token_hash = NULL, owner_user_id = NULL, claimed_at = NULL WHERE domain = 'youtube.com';
UPDATE projects SET domain = 'social', name = 'Social', website_url = '', posting_mode = 'open', claim_token_hash = NULL, owner_user_id = NULL, claimed_at = NULL WHERE domain = 'x.com';
UPDATE projects SET domain = 'marketplace', name = 'Marketplace', website_url = '', posting_mode = 'open', claim_token_hash = NULL, owner_user_id = NULL, claimed_at = NULL WHERE domain = 'facebook.com';
UPDATE projects SET domain = 'forums', name = 'Forums', website_url = '', posting_mode = 'open', claim_token_hash = NULL, owner_user_id = NULL, claimed_at = NULL WHERE domain = 'reddit.com';
UPDATE projects SET domain = 'asia-creators', name = 'Asia creators', website_url = '', posting_mode = 'open', claim_token_hash = NULL, owner_user_id = NULL, claimed_at = NULL WHERE domain = 'japanbuzz.info';

UPDATE projects SET posting_mode = 'open', claim_token_hash = NULL WHERE visibility = 'public';
