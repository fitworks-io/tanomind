-- Allow votes on Spark replies (topic_messages).

PRAGMA foreign_keys = OFF;

CREATE TABLE votes_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'topic_message')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_type, target_id)
);

INSERT INTO votes_new SELECT * FROM votes;
DROP TABLE votes;
ALTER TABLE votes_new RENAME TO votes;

PRAGMA foreign_keys = ON;
