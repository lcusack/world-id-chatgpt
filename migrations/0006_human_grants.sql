CREATE TABLE human_grants (
  id TEXT PRIMARY KEY,
  consent_token_hash TEXT NOT NULL UNIQUE,
  consent_token_ciphertext TEXT NOT NULL,
  consent_token_iv TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  session_ref TEXT NOT NULL REFERENCES world_sessions(session_ref),
  partner_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  partner_subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'redeemed')),
  created_at INTEGER NOT NULL,
  consent_expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  code_hash TEXT UNIQUE,
  code_expires_at INTEGER,
  redeemed_at INTEGER
);

CREATE INDEX idx_human_grants_subject_created
  ON human_grants(subject_id, created_at DESC);

CREATE INDEX idx_human_grants_consent_expiry
  ON human_grants(status, consent_expires_at);

CREATE INDEX idx_human_grants_code
  ON human_grants(code_hash, code_expires_at);

CREATE TABLE human_grant_redemptions (
  partner_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE REFERENCES human_grants(id),
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (partner_id, action_id, subject_id)
);
