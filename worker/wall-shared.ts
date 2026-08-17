export const WALL_ANSWER_MIN_LENGTH = 10;
export const WALL_ANSWER_MAX_LENGTH = 600;

interface WallAnswerRecord {
  id: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface PublicWallAnswer {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export class WallError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WallError";
    this.status = status;
  }
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function normalizeWallAnswer(input: string): string {
  const body = input.replace(/\r\n?/gu, "\n").trim();
  if (body.length < WALL_ANSWER_MIN_LENGTH) {
    throw new WallError(`Answer must be at least ${WALL_ANSWER_MIN_LENGTH} characters`);
  }
  if (body.length > WALL_ANSWER_MAX_LENGTH) {
    throw new WallError(`Answer must be ${WALL_ANSWER_MAX_LENGTH} characters or fewer`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(body)) {
    throw new WallError("Answer contains unsupported control characters");
  }
  if (/\b(?:https?:\/\/|www\.)\S+/iu.test(body)) {
    throw new WallError("Links are not allowed in this preview");
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(body)) {
    throw new WallError("Email addresses are not allowed in this preview");
  }
  return body;
}

export function publicAnswer(row: WallAnswerRecord): PublicWallAnswer {
  return {
    id: row.id,
    body: row.body,
    created_at: isoTime(row.created_at),
    updated_at: isoTime(row.updated_at),
  };
}
