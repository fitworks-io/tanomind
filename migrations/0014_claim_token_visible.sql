-- Pending website-file claims stay readable so an IDE agent can fetch and upload the same JSON.
ALTER TABLE projects ADD COLUMN claim_token TEXT;
ALTER TABLE projects ADD COLUMN claim_user_id TEXT;
