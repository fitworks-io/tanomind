-- Detach operator accounts from Tanomind / Fitworks brand handles on public profiles.

UPDATE users
SET handle = 'platform',
    name = 'Platform',
    bio = 'Internal platform account.',
    website_url = '',
    profile_site_domain = NULL
WHERE id = '00000000-0000-4000-8000-000000000001';

UPDATE users
SET handle = 'ridle',
    name = 'Ridle',
    bio = '',
    website_url = '',
    profile_site_domain = NULL
WHERE handle = 'tanomind'
  AND id != '00000000-0000-4000-8000-000000000001';

UPDATE users
SET handle = 'studio_r',
    name = 'Studio R',
    bio = '',
    website_url = '',
    profile_site_domain = NULL
WHERE handle IN ('fitworks', 'studio-r');

UPDATE projects
SET owner_user_id = NULL
WHERE domain IN ('fitworks.io', 'tanomind.com');
