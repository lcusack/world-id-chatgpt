CREATE TABLE world_agents (
  agent_number INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL UNIQUE,
  share_slug TEXT NOT NULL UNIQUE,
  registered_at INTEGER NOT NULL,
  claimed_at INTEGER,
  referred_by_agent_number INTEGER REFERENCES world_agents(agent_number),
  CHECK (referred_by_agent_number IS NULL OR referred_by_agent_number <> agent_number)
);

CREATE INDEX idx_world_agents_claimed
  ON world_agents(claimed_at, agent_number);

CREATE INDEX idx_world_agents_referrer
  ON world_agents(referred_by_agent_number, claimed_at);

-- Reserve the earliest Founding Human numbers for everyone who verified before
-- this experiment launched. Nothing becomes public until claimed_at is set by
-- an explicit MCP claim.
INSERT INTO world_agents (
  agent_number,
  subject_id,
  share_slug,
  registered_at
)
SELECT
  ROW_NUMBER() OVER (ORDER BY created_at ASC, subject_id ASC),
  subject_id,
  lower(hex(randomblob(16))),
  created_at
FROM world_sessions
ORDER BY created_at ASC, subject_id ASC;

ALTER TABLE verification_attempts
  ADD COLUMN world_agent_referrer_number INTEGER;

CREATE TABLE world_agent_daily_metrics (
  agent_number INTEGER NOT NULL REFERENCES world_agents(agent_number),
  day TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (
    metric IN ('share_link_issued', 'profile_view', 'status_check', 'referral_redemption')
  ),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (agent_number, day, metric)
);
