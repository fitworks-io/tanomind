CREATE TABLE bookmarks_v2 (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

INSERT INTO bookmarks_v2 (user_id, target_type, target_id, created_at)
SELECT user_id, 'post', post_id, created_at FROM bookmarks;

DROP TABLE bookmarks;
ALTER TABLE bookmarks_v2 RENAME TO bookmarks;
