import {
  openJson,
  partnerSubject,
  randomToken,
  sealJson,
  sha256,
  signPartnerAssertion,
  timingSafeEqual,
  verifyPartnerAssertion,
} from "./crypto.ts";
import type { Env, HumanGrantRow, SessionRow } from "./types.ts";

const CONSENT_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const ASSERTION_TTL_SECONDS = 15 * 60;
const MAX_SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const GRANT_ID_PATTERN = /^hgr_[A-Za-z0-9_-]{20,32}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type GrantSecret = { value: string };

export const HUMAN_GRANT_PARTNER_IDS = ["gateway-demo"] as const;
export const HUMAN_GRANT_ACTION_IDS = ["activate-demo-trial"] as const;

export type HumanGrantPartnerId = (typeof HUMAN_GRANT_PARTNER_IDS)[number];
export type HumanGrantActionId = (typeof HUMAN_GRANT_ACTION_IDS)[number];

type PartnerAction = {
  id: HumanGrantActionId;
  title: string;
  description: string;
  benefit: string;
  redemptionPolicy: "once_per_human";
};

type Partner = {
  id: HumanGrantPartnerId;
  clientId: string;
  name: string;
  description: string;
  action: PartnerAction;
};

const DEMO_PARTNER: Partner = {
  id: "gateway-demo",
  clientId: "world-id-gateway-demo",
  name: "World ID Gateway Demo",
  description: "A simulated partner that trusts a World ID human grant without registering its own relying party.",
  action: {
    id: "activate-demo-trial",
    title: "Activate a verified-human demo trial",
    description: "Share only an Orb-backed verified-human claim with the demo partner.",
    benefit: "A one-time demo entitlement showing the complete partner integration flow.",
    redemptionPolicy: "once_per_human",
  },
};

export type HumanGrantAssertion = {
  schema: "world-id-human-grant/v1";
  issuer: string;
  audience: string;
  subject: string;
  grant_id: string;
  action: string;
  verified_human: true;
  verification_level: "orb";
  world_id_protocol: "4.0";
  issued_at: string;
  expires_at: string;
};

export type HumanGrantEnvelope = {
  assertion: HumanGrantAssertion;
  issuer_signature: {
    algorithm: "HMAC-SHA-256";
    value: string;
  };
  signature_valid: true;
};

export class HumanGrantError extends Error {
  readonly code: "invalid" | "expired" | "not_configured" | "already_redeemed" | "unauthorized" | "conflict";
  readonly status: number;

  constructor(code: HumanGrantError["code"], message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "HumanGrantError";
    this.code = code;
    this.status = status;
  }
}

function partner(partnerId: string, actionId?: string): Partner {
  if (partnerId !== DEMO_PARTNER.id || (actionId !== undefined && actionId !== DEMO_PARTNER.action.id)) {
    throw new HumanGrantError("invalid", "This human-grant opportunity is not available", 404);
  }
  return DEMO_PARTNER;
}

function demoSecret(env: Env): string {
  const secret = env.HUMAN_GATEWAY_DEMO_SECRET?.trim();
  if (!secret || !TOKEN_PATTERN.test(secret)) {
    throw new HumanGrantError("not_configured", "The demo partner exchange is not configured", 503);
  }
  return secret;
}

function origin(env: Env): string {
  return env.PUBLIC_ORIGIN.replace(/\/+$/u, "");
}

function consentUrl(env: Env, token: string): string {
  return `${origin(env)}/human-grant/${encodeURIComponent(token)}`;
}

function publicOpportunity(env: Env, definition: Partner) {
  return {
    partner_id: definition.id,
    partner_name: definition.name,
    partner_description: definition.description,
    action_id: definition.action.id,
    title: definition.action.title,
    description: definition.action.description,
    benefit: definition.action.benefit,
    redemption_policy: definition.action.redemptionPolicy,
    available: Boolean(env.HUMAN_GATEWAY_DEMO_SECRET?.trim()),
    demo_url: `${origin(env)}/human-grants/demo`,
  };
}

export function listHumanGrantOpportunities(env: Env) {
  return {
    gateway_name: "World ID Human Grants",
    gateway_url: `${origin(env)}/human-grants/demo`,
    opportunities: [publicOpportunity(env, DEMO_PARTNER)],
    privacy_notice: "Partners receive a partner-specific anonymous subject and minimal assurance claims, never a World proof, World session ID, wallet, or identity.",
  };
}

export function isHumanGrantId(value: string): boolean {
  return GRANT_ID_PATTERN.test(value);
}

export function isHumanGrantToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export async function createHumanGrantFormToken(token: string): Promise<string> {
  return sha256(`human-grant-form:v1:${token}`);
}

export async function verifyHumanGrantFormToken(token: string, formToken: string | null): Promise<boolean> {
  if (!formToken || !TOKEN_PATTERN.test(formToken)) return false;
  return timingSafeEqual(await createHumanGrantFormToken(token), formToken);
}

export function humanGrantStatus(row: HumanGrantRow): "pending" | "approved" | "redeemed" | "expired" {
  if (row.status === "redeemed") return "redeemed";
  const now = Math.floor(Date.now() / 1_000);
  if (row.status === "pending") return row.consent_expires_at > now ? "pending" : "expired";
  return row.code_expires_at !== null && row.code_expires_at > now ? "approved" : "expired";
}

async function decryptConsentToken(env: Env, row: HumanGrantRow): Promise<string> {
  const secret = await openJson<GrantSecret>({
    ciphertext: row.consent_token_ciphertext,
    iv: row.consent_token_iv,
  }, env.DATA_ENCRYPTION_KEY);
  if (!isHumanGrantToken(secret.value)) throw new Error("Stored human-grant token is invalid");
  return secret.value;
}

export async function getHumanGrantById(env: Env, id: string): Promise<HumanGrantRow | null> {
  if (!isHumanGrantId(id)) return null;
  return env.DB.prepare("SELECT * FROM human_grants WHERE id = ?").bind(id).first<HumanGrantRow>();
}

export async function getHumanGrantByToken(env: Env, token: string): Promise<HumanGrantRow | null> {
  if (!isHumanGrantToken(token)) return null;
  const tokenHash = await sha256(`human-grant-consent:${token}`);
  return env.DB.prepare("SELECT * FROM human_grants WHERE consent_token_hash = ?")
    .bind(tokenHash)
    .first<HumanGrantRow>();
}

async function redemptionFor(env: Env, subjectId: string, partnerId: string, actionId: string) {
  return env.DB.prepare(
    "SELECT grant_id, redeemed_at FROM human_grant_redemptions WHERE partner_id = ? AND action_id = ? AND subject_id = ?",
  ).bind(partnerId, actionId, subjectId).first<{ grant_id: string; redeemed_at: number }>();
}

async function sessionForSubject(env: Env, subjectId: string): Promise<SessionRow> {
  const session = await env.DB.prepare("SELECT * FROM world_sessions WHERE subject_id = ?")
    .bind(subjectId)
    .first<SessionRow>();
  if (!session) throw new HumanGrantError("expired", "The linked World ID session is no longer available", 410);
  return session;
}

export async function createHumanGrant(
  env: Env,
  subjectId: string,
  partnerId: HumanGrantPartnerId,
  actionId: HumanGrantActionId,
) {
  const definition = partner(partnerId, actionId);
  demoSecret(env);
  const now = Math.floor(Date.now() / 1_000);
  const redeemed = await redemptionFor(env, subjectId, partnerId, actionId);
  if (redeemed) {
    return {
      grant_id: redeemed.grant_id,
      status: "redeemed" as const,
      opportunity: publicOpportunity(env, definition),
      redeemed_at: new Date(redeemed.redeemed_at * 1_000).toISOString(),
      security_notice: "This partner action has already been redeemed by this unique human.",
    };
  }

  const active = await env.DB.prepare(
    `SELECT * FROM human_grants
      WHERE subject_id = ? AND partner_id = ? AND action_id = ?
        AND status = 'pending' AND consent_expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(subjectId, partnerId, actionId, now).first<HumanGrantRow>();
  if (active) {
    const token = await decryptConsentToken(env, active);
    return {
      grant_id: active.id,
      status: "pending" as const,
      opportunity: publicOpportunity(env, definition),
      consent_url: consentUrl(env, token),
      expires_at: new Date(active.consent_expires_at * 1_000).toISOString(),
      security_notice: "Approval shares only a partner-specific anonymous identifier and minimal verified-human claims.",
    };
  }

  const session = await sessionForSubject(env, subjectId);
  if (session.last_verified_at <= now - MAX_SESSION_AGE_SECONDS) {
    throw new HumanGrantError("expired", "Reconnect World ID to refresh your verified-human session before granting partner access", 410);
  }
  const id = `hgr_${randomToken(18)}`;
  const token = randomToken(32);
  const tokenHash = await sha256(`human-grant-consent:${token}`);
  const sealedToken = await sealJson({ value: token } satisfies GrantSecret, env.DATA_ENCRYPTION_KEY);
  const pairwiseSubject = await partnerSubject(subjectId, partnerId, env.SUBJECT_HMAC_KEY);
  const expiresAt = now + CONSENT_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO human_grants (
      id, consent_token_hash, consent_token_ciphertext, consent_token_iv,
      subject_id, session_ref, partner_id, action_id, partner_subject,
      status, created_at, consent_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    id,
    tokenHash,
    sealedToken.ciphertext,
    sealedToken.iv,
    subjectId,
    session.session_ref,
    partnerId,
    actionId,
    pairwiseSubject,
    now,
    expiresAt,
  ).run();
  return {
    grant_id: id,
    status: "pending" as const,
    opportunity: publicOpportunity(env, definition),
    consent_url: consentUrl(env, token),
    expires_at: new Date(expiresAt * 1_000).toISOString(),
    security_notice: "Approval shares only a partner-specific anonymous identifier and minimal verified-human claims.",
  };
}

export async function approveHumanGrant(env: Env, row: HumanGrantRow) {
  if (humanGrantStatus(row) !== "pending") {
    throw new HumanGrantError("conflict", "This human grant is no longer waiting for consent", 409);
  }
  const session = await sessionForSubject(env, row.subject_id);
  const now = Math.floor(Date.now() / 1_000);
  if (session.session_ref !== row.session_ref || session.last_verified_at <= now - MAX_SESSION_AGE_SECONDS) {
    throw new HumanGrantError("expired", "The linked World ID session must be refreshed", 410);
  }
  const code = randomToken(32);
  const codeHash = await sha256(`human-grant-code:${code}`);
  const codeExpiresAt = now + CODE_TTL_SECONDS;
  const result = await env.DB.prepare(
    `UPDATE human_grants
      SET status = 'approved', approved_at = ?, code_hash = ?, code_expires_at = ?
      WHERE id = ? AND status = 'pending' AND consent_expires_at > ?`,
  ).bind(now, codeHash, codeExpiresAt, row.id, now).run();
  if (result.meta.changes !== 1) throw new HumanGrantError("conflict", "This human grant is no longer active", 409);
  const callback = new URL("/human-grants/demo/callback", env.PUBLIC_ORIGIN);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", row.id);
  return { code, callback_url: callback.toString(), expires_at: new Date(codeExpiresAt * 1_000).toISOString() };
}

function assertionJson(assertion: HumanGrantAssertion): string {
  return JSON.stringify(assertion);
}

export async function exchangeHumanGrant(
  env: Env,
  input: { clientId: string; clientSecret: string; code: string },
): Promise<HumanGrantEnvelope> {
  const definition = partner(DEMO_PARTNER.id);
  const expectedSecret = demoSecret(env);
  if (input.clientId !== definition.clientId || !timingSafeEqual(input.clientSecret, expectedSecret)) {
    throw new HumanGrantError("unauthorized", "Invalid partner credentials", 401);
  }
  if (!isHumanGrantToken(input.code)) throw new HumanGrantError("invalid", "Invalid authorization code");
  const codeHash = await sha256(`human-grant-code:${input.code}`);
  const row = await env.DB.prepare("SELECT * FROM human_grants WHERE code_hash = ? AND partner_id = ?")
    .bind(codeHash, definition.id)
    .first<HumanGrantRow>();
  const now = Math.floor(Date.now() / 1_000);
  if (!row) throw new HumanGrantError("invalid", "Invalid authorization code", 400);
  if (row.status !== "approved" || !row.code_expires_at || row.code_expires_at <= now) {
    throw new HumanGrantError("expired", "This authorization code is expired or already used", 410);
  }

  // Construct and self-verify the assertion before consuming the one-time code.
  // A malformed signing secret must never leave a valid grant marked redeemed
  // without a usable assertion reaching the partner.
  const assertion: HumanGrantAssertion = {
    schema: "world-id-human-grant/v1",
    issuer: origin(env),
    audience: definition.clientId,
    subject: row.partner_subject,
    grant_id: row.id,
    action: row.action_id,
    verified_human: true,
    verification_level: "orb",
    world_id_protocol: "4.0",
    issued_at: new Date(now * 1_000).toISOString(),
    expires_at: new Date((now + ASSERTION_TTL_SECONDS) * 1_000).toISOString(),
  };
  const signature = await signPartnerAssertion(assertionJson(assertion), expectedSecret);
  const signatureValid = await verifyPartnerAssertion(assertionJson(assertion), signature, expectedSecret);
  if (!signatureValid) throw new Error("Human-grant assertion signature failed self-verification");

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO human_grant_redemptions (partner_id, action_id, subject_id, grant_id, redeemed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(row.partner_id, row.action_id, row.subject_id, row.id, now),
      env.DB.prepare(
        `UPDATE human_grants SET status = 'redeemed', redeemed_at = ?
         WHERE id = ? AND status = 'approved' AND code_hash = ? AND code_expires_at > ?`,
      ).bind(now, row.id, codeHash, now),
    ]);
    if (results.at(-1)?.meta.changes !== 1) {
      throw new HumanGrantError("conflict", "This authorization code is no longer active", 409);
    }
  } catch (error) {
    if (error instanceof HumanGrantError) throw error;
    if (String(error).includes("human_grant_redemptions")) {
      throw new HumanGrantError("already_redeemed", "This partner action has already been redeemed by this unique human", 409);
    }
    throw error;
  }

  return {
    assertion,
    issuer_signature: { algorithm: "HMAC-SHA-256", value: signature },
    signature_valid: true,
  };
}

export async function getHumanGrantStatus(env: Env, id: string, subjectId: string) {
  const row = await getHumanGrantById(env, id);
  if (!row || row.subject_id !== subjectId) throw new HumanGrantError("invalid", "Human grant not found", 404);
  const definition = partner(row.partner_id, row.action_id);
  const status = humanGrantStatus(row);
  return {
    grant_id: row.id,
    status,
    opportunity: publicOpportunity(env, definition),
    created_at: new Date(row.created_at * 1_000).toISOString(),
    expires_at: status === "pending"
      ? new Date(row.consent_expires_at * 1_000).toISOString()
      : row.code_expires_at
        ? new Date(row.code_expires_at * 1_000).toISOString()
        : null,
    approved_at: row.approved_at ? new Date(row.approved_at * 1_000).toISOString() : null,
    redeemed_at: row.redeemed_at ? new Date(row.redeemed_at * 1_000).toISOString() : null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHumanGrantConsentPage(row: HumanGrantRow, formToken: string): string {
  const definition = partner(row.partner_id, row.action_id);
  const status = humanGrantStatus(row);
  const body = status === "pending"
    ? `<p class="lead">${escapeHtml(definition.action.description)}</p><section><h2>What ${escapeHtml(definition.name)} receives</h2><ul><li>Verified human: yes</li><li>Verification level: Orb</li><li>A partner-specific anonymous identifier</li><li>Authorization for: ${escapeHtml(definition.action.title)}</li></ul></section><section><h2>What stays private</h2><p>Your World proof, session ID, wallet, phone number, identity, and ChatGPT conversation are never shared.</p></section><form method="post"><input type="hidden" name="decision" value="approve"><input type="hidden" name="form_token" value="${escapeHtml(formToken)}"><button type="submit">Approve and continue</button></form>`
    : status === "redeemed"
      ? "<p class=\"lead\">This one-time human grant has already been redeemed by the partner.</p>"
      : status === "approved"
        ? "<p class=\"lead\">This human grant has already been approved. Return to the partner or ChatGPT to finish.</p>"
      : "<p class=\"lead\">This human-grant request has expired. Return to ChatGPT to create a fresh one.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(definition.action.title)} · World ID</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#111;background:#f3f4ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.wrap{width:min(580px,100%)}.brand{font-size:14px;font-weight:750;margin:0 0 18px}.card{background:#fff;border:1px solid #dedfd8;border-radius:26px;padding:clamp(26px,6vw,48px);box-shadow:0 24px 70px #1112}.eyebrow{color:#575b52;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:clamp(34px,7vw,52px);letter-spacing:-.045em;line-height:1.02;margin:14px 0}.lead{font-size:19px;line-height:1.55;color:#444840}section{border-top:1px solid #ecece7;margin-top:26px;padding-top:22px}h2{font-size:14px;letter-spacing:.04em;margin:0 0 10px}ul{padding-left:20px;line-height:1.7;color:#444840}section p{color:#55594f;line-height:1.6}form{margin-top:30px}button{appearance:none;border:0;border-radius:999px;background:#111;color:#fff;font:inherit;font-weight:750;padding:14px 20px;cursor:pointer;width:100%}.fine{font-size:12px;color:#74776f;line-height:1.5;margin:16px 3px 0}</style></head><body><main class="wrap"><div class="brand">World ID</div><article class="card"><div class="eyebrow">Human grant · ${escapeHtml(definition.name)}</div><h1>${escapeHtml(definition.action.title)}</h1>${body}</article><p class="fine">World ID is acting as the relying party. ${escapeHtml(definition.name)} trusts a minimal assertion issued by this gateway instead of receiving or verifying your World ID proof.</p></main></body></html>`;
}

export function renderHumanGrantDemoPage(envelope?: HumanGrantEnvelope): string {
  const result = envelope
    ? `<div class="success">✓ Trial entitlement activated</div><p>The demo partner exchanged a one-time code for this assertion:</p><pre>${escapeHtml(JSON.stringify(envelope, null, 2))}</pre>`
    : `<p>This page simulates a partner that has no World ID relying party. Ask the World ID ChatGPT connector to “activate the verified-human gateway demo” to run the complete flow.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Human Grant Partner Demo</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0c0d0c;color:#f5f6f1}*{box-sizing:border-box}body{margin:0;padding:40px 20px}.wrap{width:min(820px,100%);margin:0 auto}.eyebrow{color:#aeb4a7;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:clamp(40px,8vw,76px);line-height:.98;letter-spacing:-.055em;margin:18px 0 24px;max-width:760px}p{color:#c9cec3;font-size:18px;line-height:1.6;max-width:700px}.success{display:inline-flex;background:#d8ff69;color:#111;border-radius:999px;padding:10px 14px;font-weight:800;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#171917;border:1px solid #2e322d;border-radius:20px;padding:22px;color:#d8ff69;font:13px/1.6 ui-monospace,SFMono-Regular,monospace;margin-top:24px}</style></head><body><main class="wrap"><div class="eyebrow">Partner-side simulation</div><h1>Proof of human without becoming an RP.</h1>${result}</main></body></html>`;
}

export async function purgeExpiredHumanGrants(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1_000) - 30 * 24 * 60 * 60;
  await env.DB.prepare(
    "DELETE FROM human_grants WHERE status != 'redeemed' AND created_at < ?",
  ).bind(cutoff).run();
}
