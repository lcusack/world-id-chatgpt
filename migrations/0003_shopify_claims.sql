CREATE TABLE human_deal_claims (
  ticket_hash TEXT PRIMARY KEY,
  ticket_ciphertext TEXT NOT NULL,
  ticket_iv TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  deal_id TEXT NOT NULL CHECK (deal_id = 'unique-human-sf-15'),
  target_path TEXT NOT NULL,
  discount_code_ciphertext TEXT NOT NULL,
  discount_code_iv TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  shopify_discount_id TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  ticket_expires_at INTEGER NOT NULL,
  discount_expires_at INTEGER,
  redeemed_at INTEGER
);

CREATE INDEX idx_human_deal_claims_subject_deal
  ON human_deal_claims(subject_id, deal_id, created_at DESC);

CREATE INDEX idx_human_deal_claims_ticket_expiry
  ON human_deal_claims(ticket_expires_at);
