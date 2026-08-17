CREATE TABLE verification_attempts (
  id TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  oauth_request_ciphertext TEXT NOT NULL,
  oauth_request_iv TEXT NOT NULL,
  client_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('create_session', 'prove_session')),
  session_ref TEXT,
  rp_nonce TEXT,
  rp_signature TEXT,
  rp_created_at INTEGER,
  rp_expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'proof_verified', 'completed', 'failed')),
  subject_id TEXT,
  credential TEXT,
  protocol_version TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_verification_attempts_expires_at
  ON verification_attempts(expires_at);

CREATE TABLE world_sessions (
  session_ref TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL UNIQUE,
  session_id_ciphertext TEXT NOT NULL,
  session_id_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

CREATE TABLE proof_replays (
  replay_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_proof_replays_created_at
  ON proof_replays(created_at);
