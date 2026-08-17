import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type ClientRegistrationCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { sha256, timingSafeEqual, openJson } from "./crypto";
import {
  acceptVerifiedProof,
  createAttempt,
  getAttempt,
  getSession,
  markCompleted,
  purgeExpiredState,
  readOAuthRequest,
  saveRpContext,
} from "./db";
import { mcpApiHandler } from "./mcp";
import { DealCatalogError, listUniqueHumanDeals } from "./deals";
import { ClaimError, purgeExpiredClaims, redeemHumanDealClaim } from "./claims";
import type { AttemptRow, AuthProps, Env, HumanGrantRow } from "./types";
import { getPublicWall, WallError } from "./wall";
import { createRpContext, PublicError, verifyWorldSessionProof } from "./world-id";
import { createWorldAgentClaimFormToken, verifyWorldAgentClaimFormToken } from "./request-security";
import {
  acceptHumanIntentProof,
  getHumanIntentById,
  getHumanIntentByToken,
  getHumanIntentSessionId,
  getPublicHumanReceipt,
  humanIntentStatus,
  openHumanIntent,
  purgeExpiredHumanIntents,
  saveHumanIntentRpContext,
} from "./intents";
import type { HumanIntentRow } from "./types";
import {
  claimWorldAgent,
  getWorldAgentStatus,
  getPublicWorldAgentNetwork,
  getPublicWorldAgentProfile,
  getReferrerAgentNumber,
  recordWorldAgentProfileView,
  renderWorldAgentClaimPage,
  renderWorldAgentNetworkPage,
  renderWorldAgentProfilePage,
  resolveWorldAgentClaimToken,
  WORLD_AGENT_SLUG_PATTERN,
} from "./world-agents";
import {
  approveHumanGrant,
  createHumanGrantFormToken,
  exchangeHumanGrant,
  getHumanGrantById,
  getHumanGrantByToken,
  HumanGrantError,
  humanGrantStatus,
  isHumanGrantId,
  isHumanGrantToken,
  purgeExpiredHumanGrants,
  renderHumanGrantConsentPage,
  renderHumanGrantDemoPage,
  verifyHumanGrantFormToken,
} from "./human-grants";

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/u;
const MAX_PROOF_BYTES = 256 * 1024;
const SESSION_COOKIE = "__Host-wid-session";
const WORLD_AGENT_INVITE_COOKIE = "__Host-world-agent-invite";
const WORLD_AGENT_CLAIM_COOKIE = "__Host-world-agent-claim";
const HUMAN_INTENT_ID_PATTERN = /^hir_[A-Za-z0-9_-]{20,32}$/u;
const HUMAN_INTENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HUMAN_GRANT_CLIENT_ID = "world-id-gateway-demo";

type FailureStage = "world_verification" | "session_persistence" | "oauth_completion";

class InternalStageError extends Error {
  readonly stage: FailureStage;
  readonly causeName: string;
  readonly safeCauseMessage: string;

  constructor(stage: FailureStage, cause: unknown) {
    super(`Internal failure during ${stage}`);
    this.name = "InternalStageError";
    this.stage = stage;
    this.causeName = cause instanceof Error ? cause.name : "UnknownError";
    this.safeCauseMessage = sanitizeErrorMessage(cause instanceof Error ? cause.message : String(cause));
  }
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/session_[0-9a-f]{128}/giu, "[session_id]")
    .replace(/0x[0-9a-f]{24,}/giu, "[hex_value]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[opaque_value]")
    .slice(0, 240);
}

function routeTemplate(pathname: string): string {
  return pathname
    .replace(/^\/claim-founding-human\/[^/]{80,600}$/u, "/claim-founding-human/:token")
    .replace(/^\/claim-world-agent\/[^/]{80,600}$/u, "/claim-world-agent/:token")
    .replace(/^\/claim\/[A-Za-z0-9_-]{40,64}$/u, "/claim/:ticket")
    .replace(/^\/approve-intent\/[A-Za-z0-9_-]{43}$/u, "/approve-intent/:token")
    .replace(/^\/intent\/hir_[A-Za-z0-9_-]{20,32}$/u, "/intent/:id")
    .replace(/^\/api\/intents\/hir_[A-Za-z0-9_-]{20,32}\//u, "/api/intents/:id/")
    .replace(/^\/api\/receipts\/hir_[A-Za-z0-9_-]{20,32}$/u, "/api/receipts/:id")
    .replace(/^\/receipts\/hir_[A-Za-z0-9_-]{20,32}$/u, "/receipts/:id")
    .replace(/^\/human-grant\/[A-Za-z0-9_-]{43}$/u, "/human-grant/:token")
    .replace(/^\/human-grants\/hgr_[A-Za-z0-9_-]{20,32}\/consent$/u, "/human-grants/:id/consent")
    .replace(/^\/founding-human\/[A-Za-z0-9_-]{20,32}$/u, "/founding-human/:slug")
    .replace(/^\/world-agent\/[A-Za-z0-9_-]{20,32}$/u, "/world-agent/:slug")
    .replace(/^\/api\/founding-humans\/[A-Za-z0-9_-]{20,32}$/u, "/api/founding-humans/:slug")
    .replace(/^\/api\/world-agents\/[A-Za-z0-9_-]{20,32}$/u, "/api/world-agents/:slug")
    .replace(/^\/verify\/[A-Za-z0-9_-]{24,64}$/u, "/verify/:attempt")
    .replace(/^\/api\/verification\/[A-Za-z0-9_-]{24,64}\//u, "/api/verification/:attempt/");
}

function claimTicket(pathname: string): string | null {
  return pathname.match(/^\/claim\/([A-Za-z0-9_-]{40,64})$/u)?.[1] ?? null;
}

function worldAgentSlug(pathname: string, api = false): string | null {
  const pattern = api
    ? /^\/api\/(?:founding-humans|world-agents)\/([A-Za-z0-9_-]{20,32})$/u
    : /^\/(?:founding-human|world-agent)\/([A-Za-z0-9_-]{20,32})$/u;
  const slug = pathname.match(pattern)?.[1] ?? null;
  return slug && WORLD_AGENT_SLUG_PATTERN.test(slug) ? slug : null;
}

function setWorldAgentInviteCookie(slug: string): string {
  return `${WORLD_AGENT_INVITE_COOKIE}=${slug}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function setWorldAgentClaimCookie(token: string): string {
  return `${WORLD_AGENT_CLAIM_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearWorldAgentClaimCookie(): string {
  return `${WORLD_AGENT_CLAIM_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function atStage<T>(stage: FailureStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new InternalStageError(stage, error);
  }
}

const commonSecurityHeaders: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};

const verificationCsp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.world.org https://*.worldcoin.org",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

const worldAgentClaimCsp = verificationCsp.replace("form-action 'none'", "form-action 'self'");

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  for (const [name, headerValue] of Object.entries(commonSecurityHeaders)) responseHeaders.set(name, headerValue);
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function publicJson(value: unknown, status = 200): Response {
  const headers = new Headers(commonSecurityHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "public, max-age=15, s-maxage=30");
  return new Response(JSON.stringify(value), { status, headers });
}

async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) throw new PublicError("The confirmation payload is too large", 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return null;
}

function attemptCookieName(id: string): string {
  return `__Host-wid-auth-${id}`;
}

function setAttemptCookie(id: string, token: string): string {
  return `${attemptCookieName(id)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearAttemptCookie(id: string): string {
  return `${attemptCookieName(id)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function humanIntentCookieName(id: string): string {
  return `__Host-wid-intent-${id}`;
}

function setHumanIntentCookie(id: string, token: string): string {
  return `${humanIntentCookieName(id)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearHumanIntentCookie(id: string): string {
  return `${humanIntentCookieName(id)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function humanGrantCookieName(id: string): string {
  return `__Host-wid-grant-${id}`;
}

function setHumanGrantCookie(id: string, token: string): string {
  return `${humanGrantCookieName(id)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearHumanGrantCookie(id: string): string {
  return `${humanGrantCookieName(id)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function setSessionCookie(sessionRef: string): string {
  return `${SESSION_COOKIE}=${sessionRef}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
}

function addSecurityHeaders(response: Response, html = false, contentSecurityPolicy = verificationCsp): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(commonSecurityHeaders)) headers.set(name, value);
  if (html) {
    if (!headers.has("content-security-policy")) headers.set("content-security-policy", contentSecurityPolicy);
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function claimErrorPage(error: ClaimError): Response {
  const retryable = error.code === "busy" || error.code === "shopify";
  const heading = error.code === "expired" ? "This claim link has expired" : "We couldn't open this offer";
  const detail = error.code === "expired"
    ? "Return to ChatGPT and ask World ID for a new claim link."
    : error.code === "not_configured"
      ? "The Human Required checkout connection is not active yet."
      : retryable
        ? "Please try this link again in a moment."
        : "Return to ChatGPT and ask World ID for a new claim link.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f9f9f8"><title>${heading}</title><style>@font-face{font-family:"World Pro";src:url("/WorldProMVPVF.ttf") format("truetype");font-style:normal;font-weight:100 900;font-display:swap}*{box-sizing:border-box}body{margin:0;background:#f9f9f8;color:#181818;font:325 16px/1.5 "World Pro","Noto Sans",Helvetica,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(440px,calc(100% - 40px));background:#fff;border:1px solid #e1dfda;border-radius:24px;padding:40px;box-shadow:0 18px 50px #1818180d}.brand{display:block;width:96px;height:24px;margin-bottom:42px}h1{font-size:34px;line-height:1.08;letter-spacing:-.02em;font-weight:325;margin:0 0 14px}p{color:#75726f;margin:0 0 28px}a.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;background:#181818;color:#fff;padding:0 19px;border-radius:999px;text-decoration:none;font-weight:500}</style></head><body><main class="card"><img class="brand" src="/world-logo.svg" alt="World" width="96" height="24"><h1>${heading}</h1><p>${detail}</p><a class="button" href="/">Back to World ID</a></main></body></html>`;
  return addSecurityHeaders(new Response(html, {
    status: error.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  }), true);
}

function verificationId(pathname: string, suffix?: string): string | null {
  const pattern = suffix
    ? new RegExp(`^/api/verification/([A-Za-z0-9_-]{24,64})/${suffix}$`, "u")
    : /^\/verify\/([A-Za-z0-9_-]{24,64})$/u;
  return pathname.match(pattern)?.[1] ?? null;
}

function requestOriginMatches(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function browserBoundAttempt(env: Env, request: Request, id: string): Promise<AttemptRow> {
  const attempt = await getAttempt(env, id);
  const now = Math.floor(Date.now() / 1000);
  if (!attempt || attempt.expires_at <= now) throw new PublicError("This authorization request has expired", 410);
  const token = cookieValue(request, attemptCookieName(id));
  if (!token || !timingSafeEqual(await sha256(token), attempt.csrf_hash)) {
    throw new PublicError("This authorization request belongs to a different browser", 403);
  }
  return attempt;
}

async function browserBoundHumanIntent(env: Env, request: Request, id: string): Promise<HumanIntentRow> {
  const row = await getHumanIntentById(env, id);
  if (!row) throw new PublicError("Approval request not found", 404);
  const token = cookieValue(request, humanIntentCookieName(id));
  if (!token || !HUMAN_INTENT_TOKEN_PATTERN.test(token)) {
    throw new PublicError("This approval request belongs to a different browser", 403);
  }
  const tokenHash = await sha256(`human-intent-token:${token}`);
  if (!timingSafeEqual(tokenHash, row.token_hash)) {
    throw new PublicError("This approval request belongs to a different browser", 403);
  }
  return row;
}

async function browserBoundHumanGrant(env: Env, request: Request, id: string): Promise<{ row: HumanGrantRow; token: string }> {
  const row = await getHumanGrantById(env, id);
  if (!row) throw new HumanGrantError("invalid", "Human grant not found", 404);
  const token = cookieValue(request, humanGrantCookieName(id));
  if (!token || !isHumanGrantToken(token)) {
    throw new HumanGrantError("unauthorized", "This human grant belongs to a different browser", 403);
  }
  const tokenHash = await sha256(`human-grant-consent:${token}`);
  if (!timingSafeEqual(tokenHash, row.consent_token_hash)) {
    throw new HumanGrantError("unauthorized", "This human grant belongs to a different browser", 403);
  }
  const sessionRef = cookieValue(request, SESSION_COOKIE);
  if (!sessionRef || !timingSafeEqual(sessionRef, row.session_ref)) {
    throw new HumanGrantError("unauthorized", "Open this link in the browser where World ID was connected", 403);
  }
  return { row, token };
}

async function beginHumanGrantConsent(request: Request, env: Env, token: string): Promise<Response> {
  const row = await getHumanGrantByToken(env, token);
  if (!row) throw new HumanGrantError("invalid", "Human grant not found", 404);
  if (humanGrantStatus(row) !== "pending") {
    throw new HumanGrantError("expired", "This human grant is no longer waiting for consent", 410);
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(`/human-grants/${encodeURIComponent(row.id)}/consent`, request.url).toString(),
      "set-cookie": setHumanGrantCookie(row.id, token),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

async function humanGrantConsentPage(request: Request, env: Env, id: string): Promise<Response> {
  const { row, token } = await browserBoundHumanGrant(env, request, id);
  const formToken = await createHumanGrantFormToken(token);
  return addSecurityHeaders(new Response(renderHumanGrantConsentPage(row, formToken), {
    headers: { "content-type": "text/html; charset=utf-8" },
  }), true, worldAgentClaimCsp);
}

async function completeHumanGrantConsent(request: Request, env: Env, id: string): Promise<Response> {
  if (!requestOriginMatches(request)) throw new HumanGrantError("unauthorized", "Invalid request origin", 403);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new HumanGrantError("invalid", "Invalid consent format", 415);
  }
  const form = new URLSearchParams(await readBoundedText(request, 1_024));
  if (form.get("decision") !== "approve") throw new HumanGrantError("invalid", "Approval is required");
  const { row, token } = await browserBoundHumanGrant(env, request, id);
  if (!(await verifyHumanGrantFormToken(token, form.get("form_token")))) {
    throw new HumanGrantError("unauthorized", "Invalid consent confirmation", 403);
  }
  const { success } = await env.GRANT_RATE_LIMITER.limit({ key: `browser:${row.subject_id}` });
  if (!success) throw new HumanGrantError("conflict", "Too many consent attempts. Wait one minute and try again", 429);
  const approved = await approveHumanGrant(env, row);
  return new Response(null, {
    status: 303,
    headers: {
      location: approved.callback_url,
      "set-cookie": clearHumanGrantCookie(id),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

function basicCredentials(request: Request): { clientId: string; clientSecret: string } | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ") || authorization.length > 512) return null;
  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function humanGrantTokenExchange(request: Request, env: Env): Promise<Response> {
  const credentials = basicCredentials(request);
  if (!credentials) throw new HumanGrantError("unauthorized", "Partner authentication is required", 401);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new HumanGrantError("invalid", "The token request must use form encoding", 415);
  }
  const form = new URLSearchParams(await readBoundedText(request, 4_096));
  if (form.get("grant_type") !== "authorization_code") {
    throw new HumanGrantError("invalid", "Unsupported grant type");
  }
  const code = form.get("code") ?? "";
  const envelope = await exchangeHumanGrant(env, { ...credentials, code });
  return json(envelope);
}

async function humanGrantDemoCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!isHumanGrantToken(code) || !isHumanGrantId(state)) {
    throw new HumanGrantError("invalid", "The partner callback is invalid");
  }
  const expectedGrant = await getHumanGrantById(env, state);
  const codeHash = await sha256(`human-grant-code:${code}`);
  if (!expectedGrant?.code_hash || !timingSafeEqual(expectedGrant.code_hash, codeHash)) {
    throw new HumanGrantError("invalid", "The partner callback state does not match this grant");
  }
  const envelope = await exchangeHumanGrant(env, {
    clientId: HUMAN_GRANT_CLIENT_ID,
    clientSecret: env.HUMAN_GATEWAY_DEMO_SECRET ?? "",
    code,
  });
  return addSecurityHeaders(new Response(renderHumanGrantDemoPage(envelope), {
    headers: { "content-type": "text/html; charset=utf-8" },
  }), true);
}

async function browserWorldAgentClaim(env: Env, request: Request) {
  const token = cookieValue(request, WORLD_AGENT_CLAIM_COOKIE);
  if (!token) throw new PublicError("This Founding Human claim link is invalid or expired", 410);
  return { token, capability: await resolveWorldAgentClaimToken(env, token) };
}

async function beginWorldAgentClaim(request: Request, env: Env, token: string): Promise<Response> {
  await resolveWorldAgentClaimToken(env, token);
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/claim-founding-human", request.url).toString(),
      "set-cookie": setWorldAgentClaimCookie(token),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

async function worldAgentClaimPage(request: Request, env: Env): Promise<Response> {
  const { token, capability } = await browserWorldAgentClaim(env, request);
  const status = await getWorldAgentStatus(env, capability.subjectId);
  const formToken = await createWorldAgentClaimFormToken(token);
  return addSecurityHeaders(new Response(renderWorldAgentClaimPage(status, formToken), {
    headers: { "content-type": "text/html; charset=utf-8" },
  }), true, worldAgentClaimCsp);
}

async function completeWorldAgentClaim(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new PublicError("Invalid confirmation format", 415);
  const form = new URLSearchParams(await readBoundedText(request, 1_024));
  if (form.get("confirmation") !== "claim") throw new PublicError("Claim confirmation is required");
  const { token, capability } = await browserWorldAgentClaim(env, request);
  if (!(await verifyWorldAgentClaimFormToken(token, form.get("form_token")))) {
    throw new PublicError("Invalid claim confirmation", 403);
  }
  const { success } = await env.CLAIM_RATE_LIMITER.limit({ key: `world-agent-browser:${capability.subjectId}` });
  if (!success) throw new PublicError("Too many Founding Human claim attempts. Wait one minute and try again", 429);
  const claimed = await claimWorldAgent(env, capability.subjectId);
  return new Response(null, {
    status: 303,
    headers: {
      location: claimed.share_url,
      "set-cookie": clearWorldAgentClaimCookie(),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

function humanIntentRoute(pathname: string, suffix?: string): string | null {
  const pattern = suffix
    ? new RegExp(`^/api/intents/(hir_[A-Za-z0-9_-]{20,32})/${suffix}$`, "u")
    : /^\/intent\/(hir_[A-Za-z0-9_-]{20,32})$/u;
  return pathname.match(pattern)?.[1] ?? null;
}

function receiptId(pathname: string, api = false): string | null {
  const prefix = api ? "api/receipts" : "receipts";
  return pathname.match(new RegExp(`^/${prefix}/(hir_[A-Za-z0-9_-]{20,32})$`, "u"))?.[1] ?? null;
}

async function rateLimitKey(request: Request, namespace: string): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "local";
  return sha256(`${namespace}:${address}`);
}

function oauthErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) return new Response(error.description, { status: 400, headers: commonSecurityHeaders });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

async function beginAuthorization(request: Request, env: Env): Promise<Response> {
  const key = await rateLimitKey(request, "authorize");
  if (!(await env.AUTH_RATE_LIMITER.limit({ key })).success) {
    return new Response("Too many authorization attempts", { status: 429, headers: { ...commonSecurityHeaders, "retry-after": "60" } });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorResponse(error);
    throw error;
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) throw new PublicError("Unknown OAuth client");

  const sessionRef = cookieValue(request, SESSION_COOKIE);
  const [existingSession, worldAgentReferrerNumber] = await Promise.all([
    getSession(env, sessionRef),
    getReferrerAgentNumber(env, cookieValue(request, WORLD_AGENT_INVITE_COOKIE)),
  ]);
  const attempt = await createAttempt(
    env,
    oauthRequest,
    client.clientName || "your AI assistant",
    existingSession,
    worldAgentReferrerNumber,
  );
  const redirect = new URL(`/verify/${encodeURIComponent(attempt.id)}`, request.url);
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString(),
      "set-cookie": setAttemptCookie(attempt.id, attempt.csrfToken),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

async function verificationConfig(request: Request, env: Env, id: string): Promise<Response> {
  const attempt = await browserBoundAttempt(env, request, id);
  const session = await getSession(env, attempt.session_ref);
  let sessionId: string | undefined;
  if (attempt.mode === "prove_session") {
    if (!session) throw new PublicError("The saved World ID session is no longer available", 410);
    sessionId = (await openJson<{ sessionId: string }>({
      ciphertext: session.session_id_ciphertext,
      iv: session.session_id_iv,
    }, env.DATA_ENCRYPTION_KEY)).sessionId;
  }
  return json({
    status: attempt.status,
    expires_at: new Date(attempt.expires_at * 1000).toISOString(),
    app_id: env.WORLD_APP_ID,
    rp_id: env.WORLD_RP_ID,
    environment: env.WORLD_ENVIRONMENT,
    client_name: attempt.client_name,
    mode: attempt.mode,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
}

async function rpContextResponse(request: Request, env: Env, id: string): Promise<Response> {
  if (!requestOriginMatches(request)) throw new PublicError("Invalid request origin", 403);
  const attempt = await browserBoundAttempt(env, request, id);
  if (attempt.status !== "pending") throw new PublicError("This authorization request is no longer active", 409);
  // A nonce may have been consumed by World App even if a later host-side step
  // failed. Every explicit retry must therefore receive a fresh signed nonce.
  const context = createRpContext(env.WORLD_RP_SIGNING_KEY);
  await saveRpContext(env, id, context);
  return json({
    rp_id: env.WORLD_RP_ID,
    nonce: context.nonce,
    sig: context.sig,
    created_at: context.createdAt,
    expires_at: context.expiresAt,
  });
}

async function completeAuthorization(env: Env, attempt: AttemptRow): Promise<string> {
  if (!attempt.subject_id || !attempt.verified_at || attempt.protocol_version !== "4.0" || attempt.credential !== "proof_of_human") {
    throw new Error("Attempt is missing verified authorization claims");
  }
  const oauthRequest = await readOAuthRequest(env, attempt);
  const grantedScopes = oauthRequest.scope.filter((scope) => scope === "worldid:verify" || scope === "wall:write");
  const props: AuthProps = {
    subjectId: attempt.subject_id,
    verifiedHuman: true,
    verificationLevel: "orb",
    protocolVersion: "4.0",
    verifiedAt: new Date(attempt.verified_at * 1000).toISOString(),
    canWriteWall: grantedScopes.includes("wall:write"),
  };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: attempt.subject_id,
    metadata: { clientName: attempt.client_name },
    scope: grantedScopes,
    props,
  });
  await markCompleted(env, attempt.id);
  return redirectTo;
}

async function acceptProof(request: Request, env: Env, id: string): Promise<Response> {
  if (!requestOriginMatches(request)) throw new PublicError("Invalid request origin", 403);
  if (!(await env.PROOF_RATE_LIMITER.limit({ key: id })).success) {
    return json({ error: "Too many proof submissions" }, 429, { "retry-after": "60" });
  }
  let attempt = await browserBoundAttempt(env, request, id);
  if (attempt.status === "proof_verified") {
    const redirectUrl = await completeAuthorization(env, attempt);
    return json({ success: true, redirect_url: redirectUrl }, 200, [
      ["set-cookie", clearAttemptCookie(id)],
      ["set-cookie", setSessionCookie(attempt.session_ref!)],
    ]);
  }
  if (attempt.status !== "pending" || !attempt.rp_nonce) throw new PublicError("This authorization request is no longer active", 409);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PROOF_BYTES) throw new PublicError("The proof payload is too large", 413);
  const rawProof = await request.text();
  if (new TextEncoder().encode(rawProof).byteLength > MAX_PROOF_BYTES) throw new PublicError("The proof payload is too large", 413);
  let parsedProof: unknown;
  try {
    parsedProof = JSON.parse(rawProof);
  } catch {
    throw new PublicError("Malformed JSON proof");
  }

  const verified = await atStage("world_verification", () =>
    verifyWorldSessionProof(env, rawProof, parsedProof as Record<string, unknown>, attempt.rp_nonce!),
  );
  const accepted = await atStage("session_persistence", () => acceptVerifiedProof(env, attempt, verified));
  attempt = await atStage("session_persistence", async () => await getAttempt(env, id) as AttemptRow);
  const redirectUrl = await atStage("oauth_completion", () => completeAuthorization(env, attempt));
  const headers = new Headers();
  headers.append("set-cookie", clearAttemptCookie(id));
  headers.append("set-cookie", setSessionCookie(accepted.sessionRef));
  return json({ success: true, redirect_url: redirectUrl }, 200, headers);
}

async function beginHumanIntentApproval(request: Request, env: Env, token: string): Promise<Response> {
  const row = await getHumanIntentByToken(env, token);
  if (!row) throw new PublicError("Approval request not found", 404);
  if (humanIntentStatus(row) === "expired") throw new PublicError("This approval request has expired", 410);
  const location = new URL(`/intent/${encodeURIComponent(row.id)}`, request.url).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": setHumanIntentCookie(row.id, token),
      "cache-control": "no-store",
      ...commonSecurityHeaders,
    },
  });
}

async function humanIntentConfig(request: Request, env: Env, id: string): Promise<Response> {
  const row = await browserBoundHumanIntent(env, request, id);
  const status = humanIntentStatus(row);
  const intent = await openHumanIntent(env, row);
  return json({
    approval_id: row.id,
    status,
    expires_at: new Date(row.approval_expires_at * 1_000).toISOString(),
    intent,
    intent_hash: `sha256-${row.intent_hash}`,
    valid_until: row.valid_until ? new Date(row.valid_until * 1_000).toISOString() : null,
    ...(status === "pending" ? {
      app_id: env.WORLD_APP_ID,
      rp_id: env.WORLD_RP_ID,
      environment: env.WORLD_ENVIRONMENT,
      session_id: await getHumanIntentSessionId(env, row),
    } : {}),
    ...(status === "approved" ? {
      receipt_url: `${env.PUBLIC_ORIGIN.replace(/\/+$/u, "")}/receipts/${encodeURIComponent(row.id)}`,
    } : {}),
  });
}

async function humanIntentRpContext(request: Request, env: Env, id: string): Promise<Response> {
  if (!requestOriginMatches(request)) throw new PublicError("Invalid request origin", 403);
  const row = await browserBoundHumanIntent(env, request, id);
  if (humanIntentStatus(row) !== "pending") throw new PublicError("This approval request is no longer active", 409);
  const context = createRpContext(env.WORLD_RP_SIGNING_KEY);
  await saveHumanIntentRpContext(env, id, context);
  return json({
    rp_id: env.WORLD_RP_ID,
    nonce: context.nonce,
    sig: context.sig,
    created_at: context.createdAt,
    expires_at: context.expiresAt,
  });
}

async function acceptHumanIntent(request: Request, env: Env, id: string): Promise<Response> {
  if (!requestOriginMatches(request)) throw new PublicError("Invalid request origin", 403);
  if (!(await env.INTENT_RATE_LIMITER.limit({ key: id })).success) {
    return json({ error: "Too many approval attempts" }, 429, { "retry-after": "60" });
  }
  const row = await browserBoundHumanIntent(env, request, id);
  if (humanIntentStatus(row) !== "pending" || !row.rp_nonce) {
    throw new PublicError("This approval request is no longer active", 409);
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PROOF_BYTES) throw new PublicError("The proof payload is too large", 413);
  const rawProof = await request.text();
  if (new TextEncoder().encode(rawProof).byteLength > MAX_PROOF_BYTES) throw new PublicError("The proof payload is too large", 413);
  let parsedProof: unknown;
  try {
    parsedProof = JSON.parse(rawProof);
  } catch {
    throw new PublicError("Malformed JSON proof");
  }
  const verified = await atStage("world_verification", () =>
    verifyWorldSessionProof(env, rawProof, parsedProof as Record<string, unknown>, row.rp_nonce!),
  );
  const receipt = await atStage("session_persistence", () => acceptHumanIntentProof(env, row, verified));
  return json({
    success: true,
    receipt,
    receipt_url: receipt.receipt.verifier_url.replace("/api/receipts/", "/receipts/"),
  }, 200, { "set-cookie": clearHumanIntentCookie(id) });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function humanReceiptPage(env: Env, id: string): Promise<Response> {
  const envelope = await getPublicHumanReceipt(env, id);
  const receipt = envelope.receipt;
  const constraints = receipt.intent.constraints.length > 0
    ? `<section><h2>Constraints</h2><ul>${receipt.intent.constraints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`
    : "";
  const audience = receipt.intent.audience
    ? `<div><dt>Audience</dt><dd>${escapeHtml(receipt.intent.audience)}</dd></div>`
    : "";
  const validity = receipt.valid_until
    ? `<div><dt>Valid until</dt><dd>${escapeHtml(new Date(receipt.valid_until).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" }))}</dd></div>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f9f9f8"><title>${escapeHtml(receipt.intent.title)} · Human-approved</title><style>@font-face{font-family:"World Pro";src:url("/WorldProMVPVF.ttf") format("truetype");font-style:normal;font-weight:100 900;font-display:swap}:root{font-family:"World Pro","Noto Sans",Helvetica,sans-serif;font-weight:325;color:#181818;background:#f9f9f8;--line:#e1dfda;--muted:#75726f;--green:#00ab48}*{box-sizing:border-box}body{margin:0;padding:32px 20px;min-height:100vh}.wrap{width:min(720px,100%);margin:0 auto}.brand{display:block;width:96px;height:24px;margin-bottom:54px}.eyebrow{font-size:14px;font-weight:500;color:var(--muted);margin-bottom:14px}.card{background:#fff;border:1px solid var(--line);border-radius:24px;padding:clamp(24px,5vw,48px);box-shadow:0 20px 60px #1818180d}.badge{display:inline-flex;gap:8px;align-items:center;background:#e6f7ed;color:#006b31;border-radius:999px;padding:8px 12px;font-size:14px;font-weight:500}.badge:before{content:'✓';display:grid;place-items:center;background:var(--green);color:#fff;border-radius:50%;width:20px;height:20px}h1{font-size:clamp(34px,7vw,54px);line-height:1.04;letter-spacing:-.025em;font-weight:325;margin:24px 0 12px}.instruction{font-size:20px;line-height:1.55;white-space:pre-wrap;color:#2d2c2c;margin:0 0 30px}section{border-top:1px solid var(--line);padding-top:24px;margin-top:24px}h2{font-size:14px;font-weight:500;margin:0 0 12px;color:var(--muted)}ul{margin:0;padding-left:22px;line-height:1.65}dl{border-top:1px solid var(--line);margin:30px 0 0;padding-top:22px;display:grid;gap:14px}dl div{display:grid;grid-template-columns:130px 1fr;gap:14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.hash{font:12px/1.55 ui-monospace,SFMono-Regular,monospace;color:#575654}.foot{font-size:13px;color:var(--muted);margin:22px 4px 0;line-height:1.5}.foot a{color:inherit}@media(max-width:520px){dl div{grid-template-columns:1fr;gap:3px}.brand{margin-bottom:36px}}</style></head><body><main class="wrap"><img class="brand" src="/world-logo.svg" alt="World" width="96" height="24"><div class="eyebrow">World ID receipt</div><article class="card"><div class="badge">Approved by a unique human</div><h1>${escapeHtml(receipt.intent.title)}</h1><p class="instruction">${escapeHtml(receipt.intent.instruction)}</p>${constraints}<dl>${audience}<div><dt>Approved</dt><dd>${escapeHtml(new Date(receipt.approved_at).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" }))}</dd></div>${validity}<div><dt>Verification</dt><dd>Orb · World ID 4.0</dd></div><div><dt>Intent hash</dt><dd class="hash">${escapeHtml(receipt.intent_hash)}</dd></div><div><dt>Receipt ID</dt><dd class="hash">${escapeHtml(receipt.receipt_id)}</dd></div></dl></article><p class="foot">This issuer-verified receipt proves that an Orb-verified unique human approved the exact instruction above. It does not prove human authorship, reveal identity, or constitute a legal signature. <a href="${escapeHtml(receipt.verifier_url)}">View machine-readable receipt</a>.</p></main></body></html>`;
  return addSecurityHeaders(new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } }), true);
}

function validateClientRegistration({ clientMetadata }: ClientRegistrationCallbackOptions) {
  const redirectUris = clientMetadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
    return { code: "invalid_redirect_uri", description: "One to ten redirect URIs are required", status: 400 };
  }
  for (const value of redirectUris) {
    if (typeof value !== "string" || value.length > 2048) return { code: "invalid_redirect_uri", description: "Invalid redirect URI", status: 400 };
    try {
      const uri = new URL(value);
      const localHttp = uri.protocol === "http:" && new Set(["localhost", "127.0.0.1", "[::1]"]).has(uri.hostname);
      if ((uri.protocol !== "https:" && !localHttp) || uri.hash) throw new Error("unsafe redirect");
    } catch {
      return { code: "invalid_redirect_uri", description: "Redirect URIs must use HTTPS (localhost may use HTTP)", status: 400 };
    }
  }
  return undefined;
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const worldAgentClaimToken = url.pathname.match(/^\/(?:claim-founding-human|claim-world-agent)\/([^/]{80,600})$/u)?.[1] ?? null;
      if (request.method === "GET" && worldAgentClaimToken) {
        return await beginWorldAgentClaim(request, env, worldAgentClaimToken);
      }
      if (request.method === "GET" && (url.pathname === "/claim-founding-human" || url.pathname === "/claim-world-agent")) {
        return await worldAgentClaimPage(request, env);
      }
      if (request.method === "POST" && (url.pathname === "/claim-founding-human" || url.pathname === "/claim-world-agent")) {
        return await completeWorldAgentClaim(request, env);
      }
      const approvalToken = url.pathname.match(/^\/approve-intent\/([A-Za-z0-9_-]{43})$/u)?.[1] ?? null;
      if (request.method === "GET" && approvalToken && HUMAN_INTENT_TOKEN_PATTERN.test(approvalToken)) {
        return beginHumanIntentApproval(request, env, approvalToken);
      }
      const humanGrantToken = url.pathname.match(/^\/human-grant\/([A-Za-z0-9_-]{43})$/u)?.[1] ?? null;
      if (request.method === "GET" && humanGrantToken && isHumanGrantToken(humanGrantToken)) {
        return beginHumanGrantConsent(request, env, humanGrantToken);
      }
      const humanGrantConsentId = url.pathname.match(/^\/human-grants\/(hgr_[A-Za-z0-9_-]{20,32})\/consent$/u)?.[1] ?? null;
      if (request.method === "GET" && humanGrantConsentId && isHumanGrantId(humanGrantConsentId)) {
        return humanGrantConsentPage(request, env, humanGrantConsentId);
      }
      if (request.method === "POST" && humanGrantConsentId && isHumanGrantId(humanGrantConsentId)) {
        return completeHumanGrantConsent(request, env, humanGrantConsentId);
      }
      if (request.method === "POST" && url.pathname === "/api/human-grants/token") {
        return humanGrantTokenExchange(request, env);
      }
      if (request.method === "GET" && url.pathname === "/human-grants/demo/callback") {
        return humanGrantDemoCallback(request, env);
      }
      if (request.method === "GET" && (url.pathname === "/human-grants/demo" || url.pathname === "/human-grants/demo/")) {
        return addSecurityHeaders(new Response(renderHumanGrantDemoPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }), true);
      }
      if (request.method === "GET" && url.pathname === "/.well-known/world-id-human-grants") {
        return publicJson({
          schema: "world-id-human-grant-issuer/v1",
          issuer: env.PUBLIC_ORIGIN.replace(/\/+$/u, ""),
          token_endpoint: `${env.PUBLIC_ORIGIN.replace(/\/+$/u, "")}/api/human-grants/token`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          grant_types_supported: ["authorization_code"],
          assertion_format: "world-id-human-grant/v1",
          subject_type: "pairwise",
          claims_supported: ["verified_human", "verification_level", "world_id_protocol", "action"],
          proof_disclosure: "none",
          partner_registration: "prototype_fixed_client",
        });
      }
      const publicReceiptId = receiptId(url.pathname, true);
      if (request.method === "GET" && publicReceiptId && HUMAN_INTENT_ID_PATTERN.test(publicReceiptId)) {
        return publicJson(await getPublicHumanReceipt(env, publicReceiptId));
      }
      const receiptPageId = receiptId(url.pathname);
      if (request.method === "GET" && receiptPageId && HUMAN_INTENT_ID_PATTERN.test(receiptPageId)) {
        return humanReceiptPage(env, receiptPageId);
      }
      const ticket = claimTicket(url.pathname);
      if (request.method === "GET" && ticket) {
        const key = await sha256(`claim:${ticket}`);
        if (!(await env.CLAIM_RATE_LIMITER.limit({ key })).success) {
          return claimErrorPage(new ClaimError("busy", "Too many claim attempts", 429));
        }
        try {
          return Response.redirect(await redeemHumanDealClaim(env, ticket), 302);
        } catch (error) {
          if (error instanceof ClaimError) return claimErrorPage(error);
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/authorize") return beginAuthorization(request, env);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "world-id-chatgpt", world_id_protocol: "4.0" });
      if (request.method === "GET" && url.pathname === "/health/catalog") {
        try {
          const catalog = await listUniqueHumanDeals(env);
          return json({
            ok: true,
            service: "human-required-catalog",
            deal_count: catalog.deals.length,
            in_stock_deal_count: catalog.deals.filter((deal) => deal.availability === "available").length,
            as_of: catalog.as_of,
          });
        } catch (error) {
          const code = error instanceof DealCatalogError ? error.code : "unknown";
          const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
          console.error(JSON.stringify({
            event: "catalog_health_failed",
            code,
            error: error instanceof Error ? error.name : "UnknownError",
            detail: error instanceof Error ? sanitizeErrorMessage(error.message) : "unknown",
            cause: cause?.name,
            cause_detail: cause ? sanitizeErrorMessage(cause.message) : undefined,
          }));
          return json({ ok: false, service: "human-required-catalog", code }, 503);
        }
      }
      if (request.method === "GET" && (url.pathname === "/api/founding-humans" || url.pathname === "/api/world-agents")) {
        return publicJson(await getPublicWorldAgentNetwork(env));
      }
      const publicAgentSlug = worldAgentSlug(url.pathname, true);
      if (request.method === "GET" && publicAgentSlug) {
        return publicJson(await getPublicWorldAgentProfile(env, publicAgentSlug));
      }
      if (request.method === "GET" && new Set(["/founding-humans", "/founding-humans/", "/world-agents", "/world-agents/"]).has(url.pathname)) {
        const network = await getPublicWorldAgentNetwork(env);
        return addSecurityHeaders(new Response(renderWorldAgentNetworkPage(network), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }), true);
      }
      if (request.method === "GET" && (url.pathname === "/submit" || url.pathname === "/submit/")) {
        const asset = await env.ASSETS.fetch(new URL("/submit.html", request.url));
        return addSecurityHeaders(asset, true);
      }
      const profileSlug = worldAgentSlug(url.pathname);
      if (request.method === "GET" && profileSlug) {
        const [profile, network] = await Promise.all([
          getPublicWorldAgentProfile(env, profileSlug),
          getPublicWorldAgentNetwork(env),
        ]);
        await recordWorldAgentProfileView(env, profile.agent_number);
        return addSecurityHeaders(new Response(renderWorldAgentProfilePage(profile, network), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": setWorldAgentInviteCookie(profileSlug),
          },
        }), true);
      }
      if (request.method === "GET" && url.pathname === "/api/wall") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
        return publicJson(await getPublicWall(env, limit));
      }
      if (request.method === "GET" && (url.pathname === "/wall" || url.pathname === "/wall/")) {
        const asset = await env.ASSETS.fetch(new URL("/wall.html", request.url));
        return addSecurityHeaders(asset, true);
      }

      const pageId = verificationId(url.pathname);
      if (request.method === "GET" && pageId) {
        await browserBoundAttempt(env, request, pageId);
        const asset = await env.ASSETS.fetch(new URL("/verify.html", request.url));
        return addSecurityHeaders(asset, true);
      }
      const configId = verificationId(url.pathname, "config");
      if (request.method === "GET" && configId) return verificationConfig(request, env, configId);
      const rpId = verificationId(url.pathname, "rp-context");
      if (request.method === "POST" && rpId) return rpContextResponse(request, env, rpId);
      const proofId = verificationId(url.pathname, "proof");
      if (request.method === "POST" && proofId) return acceptProof(request, env, proofId);

      const intentPageId = humanIntentRoute(url.pathname);
      if (request.method === "GET" && intentPageId) {
        await browserBoundHumanIntent(env, request, intentPageId);
        const asset = await env.ASSETS.fetch(new URL("/intent.html", request.url));
        return addSecurityHeaders(asset, true);
      }
      const intentConfigId = humanIntentRoute(url.pathname, "config");
      if (request.method === "GET" && intentConfigId) return humanIntentConfig(request, env, intentConfigId);
      const intentRpId = humanIntentRoute(url.pathname, "rp-context");
      if (request.method === "POST" && intentRpId) return humanIntentRpContext(request, env, intentRpId);
      const intentProofId = humanIntentRoute(url.pathname, "proof");
      if (request.method === "POST" && intentProofId) return acceptHumanIntent(request, env, intentProofId);

      const asset = await env.ASSETS.fetch(request);
      return addSecurityHeaders(asset, asset.headers.get("content-type")?.includes("text/html") === true);
    } catch (error) {
      if (error instanceof PublicError || error instanceof WallError || error instanceof ClaimError || error instanceof HumanGrantError) {
        const headers = error instanceof HumanGrantError && error.status === 401
          ? { "www-authenticate": 'Basic realm="World ID Human Grants", charset="UTF-8"' }
          : undefined;
        return json({ error: error.message, ...(error instanceof HumanGrantError ? { code: error.code } : {}) }, error.status, headers);
      }
      const log = error instanceof InternalStageError
        ? {
            event: "request_failed",
            method: request.method,
            route: routeTemplate(new URL(request.url).pathname),
            stage: error.stage,
            error: error.causeName,
            detail: error.safeCauseMessage,
          }
        : {
            event: "request_failed",
            method: request.method,
            route: routeTemplate(new URL(request.url).pathname),
            error: error instanceof Error ? error.name : "UnknownError",
          };
      console.error(JSON.stringify(log));
      return json({ error: "The server could not complete this request" }, 500);
    }
  },
};

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["worldid:verify", "wall:write"],
  resourceMetadata: {
    scopes_supported: ["worldid:verify", "wall:write"],
    bearer_methods_supported: ["header"],
    resource_name: "World ID Proof of Human",
  },
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60,
  clientRegistrationTTL: 90 * 24 * 60 * 60,
  clientIdMetadataDocumentEnabled: true,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  clientRegistrationCallback: validateClientRegistration,
  onError(error) {
    console.warn(JSON.stringify({ event: "oauth_error", code: error.code, status: error.status }));
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await oauthProvider.fetch(request, env, ctx);
    return addSecurityHeaders(response, response.headers.get("content-type")?.includes("text/html") === true);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      purgeExpiredState(env),
      purgeExpiredClaims(env),
      purgeExpiredHumanIntents(env),
      purgeExpiredHumanGrants(env),
      oauthProvider.purgeExpiredData(env),
    ]).then(([, , , , oauth]) => {
      console.log(JSON.stringify({ event: "scheduled_cleanup", oauth }));
    }));
  },
} satisfies ExportedHandler<Env>;
