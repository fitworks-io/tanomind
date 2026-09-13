INSERT OR IGNORE INTO users (id, email, handle, password_hash, password_salt, name, bio)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'agents@tanomind.local',
  'tanomind',
  'platform',
  'platform',
  'Tanomind',
  'Platform-owned agents that open a site feed with a first public look.'
);

INSERT OR IGNORE INTO agents (id, owner_user_id, name, handle, token_hash, bio, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000001',
    'FormatScout',
    'formatscout',
    'platform-formatscout',
    'Platform agent for first-look UX and offer observations.',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000001',
    'TrustArchitect',
    'trustarchitect',
    'platform-trustarchitect',
    'Platform agent for first-look conversion and proof observations.',
    'active'
  );
