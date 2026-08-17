import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hmacSubject, openJson, randomToken, sealJson, sha256 } from "./crypto";
import type { AttemptRow, Env, SessionRow, StoredOAuthRequest, VerifiedSessionProof } from "./types";
import { PublicError } from "./world-id";

const ATTEMPT_TTL_SECONDS = 10 * 60;

export async function createAttempt(
  env: Env,
  oauthRequest: AuthRequest,
  clientName: string,
  existingSession: SessionRow | null,
  worldAgentReferrerNumber: number | null = null,
) {
  const id = randomToken(24);
  const csrfToken = randomToken(32);
  const csrfHash = await sha256(csrfToken);
  const sealedRequest = await sealJson({ request: oauthRequest } satisfies StoredOAuthRequest, env.DATA_ENCRYPTION_KEY);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO verification_attempts (
      id, csrf_hash, oauth_request_ciphertext, oauth_request_iv, client_name,
      mode, session_ref, status, created_at, expires_at, world_agent_referrer_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    id,
    csrfHash,
    sealedRequest.ciphertext,
    sealedRequest.iv,
    clientName.slice(0, 160),
    existingSession ? "prove_session" : "create_session",
    existingSession?.session_ref ?? null,
    now,
    now + ATTEMPT_TTL_SECONDS,
    worldAgentReferrerNumber,
  ).run();

  return { id, csrfToken, expiresAt: now + ATTEMPT_TTL_SECONDS };
}

export async function getAttempt(env: Env, id: string): Promise<AttemptRow | null> {
  return env.DB.prepare("SELECT * FROM verification_attempts WHERE id = ?")
    .bind(id)
    .first<AttemptRow>();
}

export async function getSession(env: Env, sessionRef: string | null): Promise<SessionRow | null> {
  if (!sessionRef) return null;
  return env.DB.prepare("SELECT * FROM world_sessions WHERE session_ref = ?")
    .bind(sessionRef)
    .first<SessionRow>();
}

export async function saveRpContext(
  env: Env,
  id: string,
  context: { nonce: string; sig: string; createdAt: number; expiresAt: number },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE verification_attempts
       SET rp_nonce = ?, rp_signature = ?, rp_created_at = ?, rp_expires_at = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(context.nonce, context.sig, context.createdAt, context.expiresAt, id, Math.floor(Date.now() / 1000)).run();
  if (result.meta.changes !== 1) throw new PublicError("This authorization request has expired", 410);
}

export async function acceptVerifiedProof(
  env: Env,
  attempt: AttemptRow,
  proof: VerifiedSessionProof,
): Promise<{ subjectId: string; sessionRef: string }> {
  const subjectId = await hmacSubject(proof.sessionId, env.SUBJECT_HMAC_KEY);
  const replayHash = await sha256(`proof-replay:${proof.replayValue}`);
  const now = proof.verifiedAt;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT INTO proof_replays (replay_hash, created_at) VALUES (?, ?)").bind(replayHash, now),
  ];
  const worldAgentShareSlug = randomToken(18);

  let sessionRef = attempt.session_ref;
  if (attempt.mode === "prove_session") {
    const existing = await getSession(env, attempt.session_ref);
    if (!existing) throw new PublicError("The saved World ID session is no longer available", 410);
    const storedSession = await openJson<{ sessionId: string }>({
      ciphertext: existing.session_id_ciphertext,
      iv: existing.session_id_iv,
    }, env.DATA_ENCRYPTION_KEY);
    if (storedSession.sessionId !== proof.sessionId || existing.subject_id !== subjectId) {
      throw new PublicError("The World ID session does not match this browser");
    }
    statements.push(
      env.DB.prepare("UPDATE world_sessions SET last_verified_at = ? WHERE session_ref = ? AND subject_id = ?")
        .bind(now, existing.session_ref, subjectId),
    );
  } else {
    sessionRef = randomToken(24);
    const sealedSession = await sealJson({ sessionId: proof.sessionId }, env.DATA_ENCRYPTION_KEY);
    statements.push(
      env.DB.prepare(
        `INSERT INTO world_sessions (
          session_ref, subject_id, session_id_ciphertext, session_id_iv, created_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(sessionRef, subjectId, sealedSession.ciphertext, sealedSession.iv, now, now),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO world_agents (
        subject_id, share_slug, registered_at, referred_by_agent_number
      ) VALUES (?, ?, ?, ?)`,
    ).bind(subjectId, worldAgentShareSlug, now, attempt.world_agent_referrer_number),
    env.DB.prepare(
      `UPDATE verification_attempts
         SET status = 'proof_verified', subject_id = ?, credential = ?, protocol_version = ?,
             verified_at = ?, session_ref = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    ).bind(subjectId, proof.credential, proof.protocolVersion, now, sessionRef, attempt.id, now),
  );

  try {
    const results = await env.DB.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new PublicError("This authorization request is no longer active", 409);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (String(error).includes("proof_replays.replay_hash")) {
      throw new PublicError("This World ID proof has already been used", 409);
    }
    throw error;
  }
  if (!sessionRef) throw new Error("Session reference was not created");
  return { subjectId, sessionRef };
}

export async function readOAuthRequest(env: Env, attempt: AttemptRow): Promise<AuthRequest> {
  const stored = await openJson<StoredOAuthRequest>({
    ciphertext: attempt.oauth_request_ciphertext,
    iv: attempt.oauth_request_iv,
  }, env.DATA_ENCRYPTION_KEY);
  return stored.request;
}

export async function markCompleted(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE verification_attempts SET status = 'completed' WHERE id = ? AND status = 'proof_verified'")
    .bind(id)
    .run();
}

export async function purgeExpiredState(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM verification_attempts WHERE expires_at < ?").bind(now - 86_400),
    env.DB.prepare("DELETE FROM proof_replays WHERE created_at < ?").bind(now - 90 * 86_400),
  ]);
}
