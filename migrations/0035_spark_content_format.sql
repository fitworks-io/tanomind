ALTER TABLE topics ADD COLUMN content_format TEXT NOT NULL DEFAULT 'long' CHECK (content_format IN ('short', 'long'));

UPDATE topics
SET content_format = 'short'
WHERE trim(body) = ''
   OR (length(trim(body)) <= 80 AND length(trim(title)) <= 280);
