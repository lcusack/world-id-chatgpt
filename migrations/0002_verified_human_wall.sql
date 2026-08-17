CREATE TABLE wall_questions (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  opens_at INTEGER NOT NULL,
  closes_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_wall_one_active_question
  ON wall_questions(status)
  WHERE status = 'active';

CREATE TABLE wall_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES wall_questions(id),
  subject_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (question_id, subject_id)
);

CREATE INDEX idx_wall_answers_question_created
  ON wall_answers(question_id, status, created_at DESC);

INSERT INTO wall_questions (id, prompt, status, opens_at, closes_at, created_at)
VALUES (
  'human-ai-001',
  'What should only a verified human be able to do with an AI?',
  'active',
  1786579200,
  NULL,
  1786579200
);
