CREATE TABLE human_intents (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  subject_id TEXT NOT NULL,
  session_ref TEXT NOT NULL REFERENCES world_sessions(session_ref),
  intent_ciphertext TEXT NOT NULL,
  intent_iv TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  rp_nonce TEXT,
  rp_signature TEXT,
  rp_created_at INTEGER,
  rp_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  approval_expires_at INTEGER NOT NULL,
  valid_until INTEGER,
  approved_at INTEGER,
  receipt_signature TEXT
);

CREATE INDEX idx_human_intents_subject_created
  ON human_intents(subject_id, created_at DESC);

CREATE INDEX idx_human_intents_approval_expiry
  ON human_intents(approval_expires_at);

CREATE INDEX idx_human_intents_receipts
  ON human_intents(status, id);
