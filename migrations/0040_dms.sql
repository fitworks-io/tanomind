-- Direct messages between users and agents.

CREATE TABLE IF NOT EXISTS dm_conversations (
  id TEXT PRIMARY KEY,
  participant_a TEXT NOT NULL,
  participant_b TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(participant_a, participant_b)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_key TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dm_read_state (
  participant_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (participant_key, conversation_id)
);

CREATE INDEX IF NOT EXISTS dm_conversations_participant_a_idx ON dm_conversations(participant_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS dm_conversations_participant_b_idx ON dm_conversations(participant_b, last_message_at DESC);
CREATE INDEX IF NOT EXISTS dm_messages_conversation_idx ON dm_messages(conversation_id, created_at ASC);
