import { randomToken } from "./crypto";
import type { Env } from "./types";
import {
  normalizeWallAnswer,
  publicAnswer,
  WallError,
  type PublicWallAnswer,
} from "./wall-shared";

export {
  normalizeWallAnswer,
  publicAnswer,
  WallError,
  WALL_ANSWER_MAX_LENGTH,
  WALL_ANSWER_MIN_LENGTH,
} from "./wall-shared";

interface WallQuestionRow {
  id: string;
  prompt: string;
  opens_at: number;
  closes_at: number | null;
}

interface WallAnswerRow {
  id: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface PublicWallQuestion {
  id: string;
  prompt: string;
  opens_at: string;
  closes_at: string | null;
}

export interface PublicWall {
  question: PublicWallQuestion;
  answer_count: number;
  answers: PublicWallAnswer[];
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function publicQuestion(row: WallQuestionRow): PublicWallQuestion {
  return {
    id: row.id,
    prompt: row.prompt,
    opens_at: isoTime(row.opens_at),
    closes_at: row.closes_at === null ? null : isoTime(row.closes_at),
  };
}

async function activeQuestion(env: Env): Promise<WallQuestionRow> {
  const now = Math.floor(Date.now() / 1000);
  const question = await env.DB.prepare(
    `SELECT id, prompt, opens_at, closes_at
       FROM wall_questions
      WHERE status = 'active'
        AND opens_at <= ?
        AND (closes_at IS NULL OR closes_at > ?)
      LIMIT 1`,
  ).bind(now, now).first<WallQuestionRow>();
  if (!question) throw new WallError("There is no active Verified Human Wall question", 404);
  return question;
}

async function answerCount(env: Env, questionId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM wall_answers WHERE question_id = ? AND status = 'published'",
  ).bind(questionId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function getWallQuestion(env: Env): Promise<{ question: PublicWallQuestion; answer_count: number }> {
  const question = await activeQuestion(env);
  return {
    question: publicQuestion(question),
    answer_count: await answerCount(env, question.id),
  };
}

export async function getPublicWall(env: Env, requestedLimit = 50): Promise<PublicWall> {
  const question = await activeQuestion(env);
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit)));
  const [count, result] = await Promise.all([
    answerCount(env, question.id),
    env.DB.prepare(
      `SELECT id, body, created_at, updated_at
         FROM wall_answers
        WHERE question_id = ? AND status = 'published'
        ORDER BY created_at DESC
        LIMIT ?`,
    ).bind(question.id, limit).all<WallAnswerRow>(),
  ]);
  return {
    question: publicQuestion(question),
    answer_count: count,
    answers: result.results.map(publicAnswer),
  };
}

export async function publishWallAnswer(
  env: Env,
  subjectId: string,
  rawAnswer: string,
): Promise<{ answer: PublicWallAnswer; updated: boolean }> {
  const body = normalizeWallAnswer(rawAnswer);
  const question = await activeQuestion(env);
  const existing = await env.DB.prepare(
    "SELECT id FROM wall_answers WHERE question_id = ? AND subject_id = ?",
  ).bind(question.id, subjectId).first<{ id: string }>();
  const id = existing?.id ?? randomToken(18);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO wall_answers (
       id, question_id, subject_id, body, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'published', ?, ?)
     ON CONFLICT(question_id, subject_id) DO UPDATE SET
       body = excluded.body,
       status = 'published',
       updated_at = excluded.updated_at`,
  ).bind(id, question.id, subjectId, body, now, now).run();

  const stored = await env.DB.prepare(
    "SELECT id, body, created_at, updated_at FROM wall_answers WHERE question_id = ? AND subject_id = ?",
  ).bind(question.id, subjectId).first<WallAnswerRow>();
  if (!stored) throw new WallError("The answer could not be loaded after publishing", 500);
  return { answer: publicAnswer(stored), updated: existing !== null };
}
