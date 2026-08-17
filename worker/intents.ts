import { hmacSubject, openJson, randomToken, sealJson, sha256, signReceipt, verifyReceiptSignature } from "./crypto.ts";
import type { Env, HumanIntentRow, SessionRow, VerifiedSessionProof } from "./types.ts";
import { PublicError } from "./world-id.ts";

const APPROVAL_TTL_SECONDS = 10 * 60;
const MAX_INTENT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export interface HumanIntentInput {
  title: string;
  instruction: string;
  audience?: string;
  constraints?: string[];
  valid_until?: string;
}

export interface CanonicalHumanIntent {
  title: string;
  instruction: string;
  audience: string | null;
  constraints: string[];
}

export interface HumanApprovalReceiptPayload {
  schema: "world-id-human-approval-receipt/v1";
  issuer: string;
  receipt_id: string;
  human_approved: true;
  verification_level: "orb";
  world_id_protocol: "4.0";
  intent: CanonicalHumanIntent;
  intent_hash: string;
  approved_at: string;
  valid_until: string | null;
  verifier_url: string;
}

export interface HumanApprovalReceipt {
  receipt: HumanApprovalReceiptPayload;
  issuer_signature: {
    algorithm: "HMAC-SHA-256";
    value: string;
  };
  signature_valid: true;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

export function canonicalizeHumanIntent(input: HumanIntentInput): CanonicalHumanIntent {
  const title = normalizeText(input.title);
  const instruction = normalizeText(input.instruction);
  const audience = input.audience === undefined ? null : normalizeText(input.audience) || null;
  const constraints = (input.constraints ?? []).map(normalizeText);
  if (title.length < 3 || title.length > 120) throw new PublicError("Intent title must be 3 to 120 characters");
  if (instruction.length < 10 || instruction.length > 2_000) throw new PublicError("Intent instruction must be 10 to 2,000 characters");
  if (audience && audience.length > 200) throw new PublicError("Intent audience must be at most 200 characters");
  if (constraints.length > 10 || constraints.some((item) => item.length < 1 || item.length > 300)) {
    throw new PublicError("Use at most 10 non-empty constraints of 300 characters each");
  }
  return { title, instruction, audience, constraints };
}

export function canonicalIntentJson(intent: CanonicalHumanIntent): string {
  return JSON.stringify({
    title: intent.title,
    instruction: intent.instruction,
    audience: intent.audience,
    constraints: intent.constraints,
  });
}

function normalizedOrigin(origin: string): string {
  return origin.replace(/\/+$/u, "");
}

function receiptPayload(row: HumanIntentRow, intent: CanonicalHumanIntent, origin: string): HumanApprovalReceiptPayload {
  if (!row.approved_at) throw new PublicError("This intent has not been approved", 404);
  const base = normalizedOrigin(origin);
  return {
    schema: "world-id-human-approval-receipt/v1",
    issuer: base,
    receipt_id: row.id,
    human_approved: true,
    verification_level: "orb",
    world_id_protocol: "4.0",
    intent,
    intent_hash: `sha256-${row.intent_hash}`,
    approved_at: new Date(row.approved_at * 1_000).toISOString(),
    valid_until: row.valid_until ? new Date(row.valid_until * 1_000).toISOString() : null,
    verifier_url: `${base}/api/receipts/${encodeURIComponent(row.id)}`,
  };
}

function receiptSigningJson(payload: HumanApprovalReceiptPayload): string {
  return JSON.stringify(payload);
}

async function sessionForSubject(env: Env, subjectId: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM world_sessions WHERE subject_id = ?")
    .bind(subjectId)
    .first<SessionRow>();
}

export async function createHumanIntent(env: Env, subjectId: string, input: HumanIntentInput) {
  const session = await sessionForSubject(env, subjectId);
  if (!session) throw new PublicError("Reconnect World ID before creating a human approval", 410);
  const intent = canonicalizeHumanIntent(input);
  const canonical = canonicalIntentJson(intent);
  const intentHash = await sha256(canonical);
  const token = randomToken(32);
  const id = `hir_${randomToken(18)}`;
  const tokenHash = await sha256(`human-intent-token:${token}`);
  const sealedIntent = await sealJson(intent, env.DATA_ENCRYPTION_KEY);
  const now = Math.floor(Date.now() / 1_000);
  let validUntil: number | null = null;
  if (input.valid_until) {
    validUntil = Math.floor(new Date(input.valid_until).getTime() / 1_000);
    if (!Number.isFinite(validUntil) || validUntil < now + 5 * 60) {
      throw new PublicError("valid_until must be at least five minutes in the future");
    }
    if (validUntil > now + MAX_INTENT_LIFETIME_SECONDS) {
      throw new PublicError("valid_until cannot be more than 30 days in the future");
    }
  }
  const approvalExpiresAt = Math.min(now + APPROVAL_TTL_SECONDS, validUntil ?? Number.MAX_SAFE_INTEGER);
  await env.DB.prepare(
    `INSERT INTO human_intents (
      id, token_hash, subject_id, session_ref, intent_ciphertext, intent_iv, intent_hash,
      status, created_at, approval_expires_at, valid_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    id,
    tokenHash,
    subjectId,
    session.session_ref,
    sealedIntent.ciphertext,
    sealedIntent.iv,
    intentHash,
    now,
    approvalExpiresAt,
    validUntil,
  ).run();
  return {
    approval_id: id,
    approval_url: `${normalizedOrigin(env.PUBLIC_ORIGIN)}/approve-intent/${token}`,
    intent,
    intent_hash: `sha256-${intentHash}`,
    expires_at: new Date(approvalExpiresAt * 1_000).toISOString(),
  };
}

export async function getHumanIntentById(env: Env, id: string): Promise<HumanIntentRow | null> {
  return env.DB.prepare("SELECT * FROM human_intents WHERE id = ?").bind(id).first<HumanIntentRow>();
}

export async function getHumanIntentForSubject(env: Env, id: string, subjectId: string): Promise<HumanIntentRow | null> {
  return env.DB.prepare("SELECT * FROM human_intents WHERE id = ? AND subject_id = ?")
    .bind(id, subjectId)
    .first<HumanIntentRow>();
}

export async function getHumanIntentByToken(env: Env, token: string): Promise<HumanIntentRow | null> {
  const tokenHash = await sha256(`human-intent-token:${token}`);
  return env.DB.prepare("SELECT * FROM human_intents WHERE token_hash = ?")
    .bind(tokenHash)
    .first<HumanIntentRow>();
}

export async function openHumanIntent(env: Env, row: HumanIntentRow): Promise<CanonicalHumanIntent> {
  return openJson<CanonicalHumanIntent>({ ciphertext: row.intent_ciphertext, iv: row.intent_iv }, env.DATA_ENCRYPTION_KEY);
}

export function humanIntentStatus(row: HumanIntentRow): "pending" | "approved" | "expired" {
  if (row.status === "approved") return "approved";
  return row.approval_expires_at > Math.floor(Date.now() / 1_000) ? "pending" : "expired";
}

export async function saveHumanIntentRpContext(
  env: Env,
  id: string,
  context: { nonce: string; sig: string; createdAt: number; expiresAt: number },
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const result = await env.DB.prepare(
    `UPDATE human_intents SET rp_nonce = ?, rp_signature = ?, rp_created_at = ?, rp_expires_at = ?
     WHERE id = ? AND status = 'pending' AND approval_expires_at > ?`,
  ).bind(context.nonce, context.sig, context.createdAt, context.expiresAt, id, now).run();
  if (result.meta.changes !== 1) throw new PublicError("This approval request has expired", 410);
}

export async function getHumanIntentSessionId(env: Env, row: HumanIntentRow): Promise<string> {
  const session = await env.DB.prepare("SELECT * FROM world_sessions WHERE session_ref = ? AND subject_id = ?")
    .bind(row.session_ref, row.subject_id)
    .first<SessionRow>();
  if (!session) throw new PublicError("The linked World ID session is no longer available", 410);
  return (await openJson<{ sessionId: string }>({
    ciphertext: session.session_id_ciphertext,
    iv: session.session_id_iv,
  }, env.DATA_ENCRYPTION_KEY)).sessionId;
}

export async function acceptHumanIntentProof(
  env: Env,
  row: HumanIntentRow,
  proof: VerifiedSessionProof,
): Promise<HumanApprovalReceipt> {
  if (row.status !== "pending" || row.approval_expires_at <= proof.verifiedAt) {
    throw new PublicError("This approval request is no longer active", 409);
  }
  const sessionId = await getHumanIntentSessionId(env, row);
  const subjectId = await hmacSubject(proof.sessionId, env.SUBJECT_HMAC_KEY);
  if (proof.sessionId !== sessionId || subjectId !== row.subject_id) {
    throw new PublicError("This proof does not match the World ID account that created the intent", 403);
  }
  const intent = await openHumanIntent(env, row);
  if (!row.rp_nonce || row.intent_hash !== await sha256(canonicalIntentJson(intent))) {
    throw new Error("Intent binding is incomplete or invalid");
  }
  const approvedRow: HumanIntentRow = { ...row, status: "approved", approved_at: proof.verifiedAt };
  const payload = receiptPayload(approvedRow, intent, env.PUBLIC_ORIGIN);
  const signature = await signReceipt(receiptSigningJson(payload), env.SUBJECT_HMAC_KEY);
  const replayHash = await sha256(`proof-replay:${proof.replayValue}`);
  try {
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO proof_replays (replay_hash, created_at) VALUES (?, ?)").bind(replayHash, proof.verifiedAt),
      env.DB.prepare("UPDATE world_sessions SET last_verified_at = ? WHERE session_ref = ? AND subject_id = ?")
        .bind(proof.verifiedAt, row.session_ref, row.subject_id),
      env.DB.prepare(
        `UPDATE human_intents SET status = 'approved', approved_at = ?, receipt_signature = ?
         WHERE id = ? AND status = 'pending' AND approval_expires_at > ? AND rp_nonce = ?`,
      ).bind(proof.verifiedAt, signature, row.id, proof.verifiedAt, row.rp_nonce),
    ]);
    if (results.at(-1)?.meta.changes !== 1) throw new PublicError("This approval request is no longer active", 409);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (String(error).includes("proof_replays.replay_hash")) {
      throw new PublicError("This World ID proof has already been used", 409);
    }
    throw error;
  }
  return {
    receipt: payload,
    issuer_signature: { algorithm: "HMAC-SHA-256", value: signature },
    signature_valid: true,
  };
}

export async function getPublicHumanReceipt(env: Env, id: string): Promise<HumanApprovalReceipt> {
  const row = await getHumanIntentById(env, id);
  if (!row || row.status !== "approved" || !row.receipt_signature || !row.approved_at) {
    throw new PublicError("Receipt not found", 404);
  }
  const intent = await openHumanIntent(env, row);
  const payload = receiptPayload(row, intent, env.PUBLIC_ORIGIN);
  const valid = await verifyReceiptSignature(receiptSigningJson(payload), row.receipt_signature, env.SUBJECT_HMAC_KEY);
  if (!valid) throw new Error("Stored receipt signature is invalid");
  return {
    receipt: payload,
    issuer_signature: { algorithm: "HMAC-SHA-256", value: row.receipt_signature },
    signature_valid: true,
  };
}

export async function getHumanIntentResult(env: Env, id: string, subjectId: string) {
  const row = await getHumanIntentForSubject(env, id, subjectId);
  if (!row) throw new PublicError("Approval request not found", 404);
  const status = humanIntentStatus(row);
  return {
    approval_id: row.id,
    status,
    intent_hash: `sha256-${row.intent_hash}`,
    expires_at: new Date(row.approval_expires_at * 1_000).toISOString(),
    ...(status === "approved" ? { receipt: await getPublicHumanReceipt(env, row.id) } : {}),
  };
}

export async function purgeExpiredHumanIntents(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1_000) - 30 * 24 * 60 * 60;
  await env.DB.prepare("DELETE FROM human_intents WHERE status = 'pending' AND approval_expires_at < ?")
    .bind(cutoff)
    .run();
}
