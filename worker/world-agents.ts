import { openJson, randomToken, sealJson } from "./crypto.ts";
import type { Env, WorldAgentRow } from "./types.ts";
import { PublicError } from "./world-id.ts";

export const GENESIS_WORLD_AGENT_LIMIT = 100;
export const WORLD_AGENT_SLUG_PATTERN = /^[A-Za-z0-9_-]{20,32}$/u;
const WORLD_AGENT_SUBJECT_PATTERN = /^wid_[A-Za-z0-9_-]{43}$/u;
const WORLD_AGENT_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64,512}$/u;
const WORLD_AGENT_CLAIM_TTL_SECONDS = 10 * 60;

type WorldAgentMetric = "share_link_issued" | "profile_view" | "status_check" | "referral_redemption";

export interface PublicWorldAgentProfile {
  agent_number: number;
  display_number: string;
  cohort: "Genesis 100" | "Founding 1,000" | "Early 10,000" | "Founding Human";
  registered_at: string;
  claimed_at: string;
  verification: "Orb · World ID 4.0";
  share_url: string;
  invite_url: string;
}

export interface WorldAgentNetwork {
  name: "World ID";
  claimed_humans: number;
  genesis_claimed: number;
  genesis_limit: 100;
  genesis_complete: boolean;
  next_capability: string;
  network_url: string;
}

export interface ClaimedWorldAgent extends PublicWorldAgentProfile {
  verified_human: true;
  verification_level: "orb";
  protocol_version: "4.0";
  unique_humans_invited: number;
  network: WorldAgentNetwork;
  share_text: string;
  privacy_notice: string;
}

interface WorldAgentClaimCapability {
  purpose: "world-agent-claim";
  subjectId: string;
  expiresAt: number;
}

function normalizedOrigin(origin: string): string {
  return origin.replace(/\/+$/u, "");
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

export async function createWorldAgentClaimLink(
  env: Pick<Env, "DATA_ENCRYPTION_KEY" | "PUBLIC_ORIGIN">,
  subjectId: string,
): Promise<{ claimUrl: string; expiresAt: string }> {
  if (!WORLD_AGENT_SUBJECT_PATTERN.test(subjectId)) throw new Error("Invalid Founding Human subject");
  const expiresAt = Math.floor(Date.now() / 1_000) + WORLD_AGENT_CLAIM_TTL_SECONDS;
  const sealed = await sealJson({
    purpose: "world-agent-claim",
    subjectId,
    expiresAt,
  } satisfies WorldAgentClaimCapability, env.DATA_ENCRYPTION_KEY);
  const token = `${sealed.iv}.${sealed.ciphertext}`;
  return {
    claimUrl: `${normalizedOrigin(env.PUBLIC_ORIGIN)}/claim-founding-human/${encodeURIComponent(token)}`,
    expiresAt: isoTime(expiresAt),
  };
}

export async function resolveWorldAgentClaimToken(
  env: Pick<Env, "DATA_ENCRYPTION_KEY">,
  token: string,
): Promise<WorldAgentClaimCapability> {
  if (!WORLD_AGENT_CLAIM_TOKEN_PATTERN.test(token)) {
    throw new PublicError("This Founding Human claim link is invalid or expired", 410);
  }
  const [iv, ciphertext] = token.split(".");
  try {
    const capability = await openJson<WorldAgentClaimCapability>({ iv, ciphertext }, env.DATA_ENCRYPTION_KEY);
    if (
      capability.purpose !== "world-agent-claim"
      || !WORLD_AGENT_SUBJECT_PATTERN.test(capability.subjectId)
      || !Number.isInteger(capability.expiresAt)
      || capability.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw new Error("invalid capability");
    }
    return capability;
  } catch {
    throw new PublicError("This Founding Human claim link is invalid or expired", 410);
  }
}

export function displayWorldAgentNumber(agentNumber: number): string {
  return `#${String(agentNumber).padStart(4, "0")}`;
}

export function worldAgentCohort(agentNumber: number): PublicWorldAgentProfile["cohort"] {
  if (agentNumber <= GENESIS_WORLD_AGENT_LIMIT) return "Genesis 100";
  if (agentNumber <= 1_000) return "Founding 1,000";
  if (agentNumber <= 10_000) return "Early 10,000";
  return "Founding Human";
}

function publicProfile(env: Env, row: WorldAgentRow): PublicWorldAgentProfile {
  if (!row.claimed_at) throw new PublicError("Founding Human not found", 404);
  const origin = normalizedOrigin(env.PUBLIC_ORIGIN);
  const shareUrl = `${origin}/founding-human/${encodeURIComponent(row.share_slug)}`;
  return {
    agent_number: row.agent_number,
    display_number: displayWorldAgentNumber(row.agent_number),
    cohort: worldAgentCohort(row.agent_number),
    registered_at: isoTime(row.registered_at),
    claimed_at: isoTime(row.claimed_at),
    verification: "Orb · World ID 4.0",
    share_url: shareUrl,
    invite_url: shareUrl,
  };
}

async function networkCounts(database: D1Database | D1DatabaseSession): Promise<{
  claimedHumans: number;
  genesisClaimed: number;
}> {
  const row = await database.prepare(
    `SELECT
       COUNT(*) AS claimed_humans,
       SUM(CASE WHEN agent_number <= ? THEN 1 ELSE 0 END) AS genesis_claimed
     FROM world_agents
     WHERE claimed_at IS NOT NULL`,
  ).bind(GENESIS_WORLD_AGENT_LIMIT).first<{ claimed_humans: number; genesis_claimed: number | null }>();
  return {
    claimedHumans: Number(row?.claimed_humans ?? 0),
    genesisClaimed: Number(row?.genesis_claimed ?? 0),
  };
}

function networkProjection(env: Env, counts: { claimedHumans: number; genesisClaimed: number }): WorldAgentNetwork {
  return {
    name: "World ID",
    claimed_humans: counts.claimedHumans,
    genesis_claimed: counts.genesisClaimed,
    genesis_limit: GENESIS_WORLD_AGENT_LIMIT,
    genesis_complete: counts.genesisClaimed >= GENESIS_WORLD_AGENT_LIMIT,
    next_capability: counts.genesisClaimed >= GENESIS_WORLD_AGENT_LIMIT
      ? "The Genesis 100 is complete. A new verified-human capability is coming next."
      : "When 100 unique humans claim a place, the Genesis card becomes a permanent completed-cohort treatment and a new capability will be revealed.",
    network_url: `${normalizedOrigin(env.PUBLIC_ORIGIN)}/founding-humans`,
  };
}

async function incrementMetric(env: Env, agentNumber: number, metric: WorldAgentMetric): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `INSERT INTO world_agent_daily_metrics (agent_number, day, metric, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(agent_number, day, metric) DO UPDATE SET count = count + 1`,
    ).bind(agentNumber, day, metric).run();
  } catch (error) {
    console.warn(JSON.stringify({
      event: "world_agent_metric_failed",
      metric,
      error: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

async function privateAgentForSubject(
  database: D1Database | D1DatabaseSession,
  subjectId: string,
): Promise<WorldAgentRow | null> {
  return database.prepare("SELECT * FROM world_agents WHERE subject_id = ?")
    .bind(subjectId)
    .first<WorldAgentRow>();
}

export async function getReferrerAgentNumber(env: Env, slug: string | null): Promise<number | null> {
  if (!slug || !WORLD_AGENT_SLUG_PATTERN.test(slug)) return null;
  const row = await env.DB.prepare(
    "SELECT agent_number FROM world_agents WHERE share_slug = ? AND claimed_at IS NOT NULL",
  ).bind(slug).first<{ agent_number: number }>();
  return row ? Number(row.agent_number) : null;
}

export async function claimWorldAgent(env: Env, subjectId: string): Promise<ClaimedWorldAgent> {
  const session = env.DB.withSession("first-primary");
  let row = await privateAgentForSubject(session, subjectId);
  if (!row) {
    await session.prepare(
      `INSERT OR IGNORE INTO world_agents (subject_id, share_slug, registered_at)
       VALUES (?, ?, ?)`,
    ).bind(subjectId, randomToken(18), Math.floor(Date.now() / 1_000)).run();
    row = await privateAgentForSubject(session, subjectId);
  }
  if (!row) throw new Error("The Founding Human registry could not allocate a place");

  const now = Math.floor(Date.now() / 1_000);
  const claimed = await session.prepare(
    "UPDATE world_agents SET claimed_at = ? WHERE subject_id = ? AND claimed_at IS NULL",
  ).bind(now, subjectId).run();
  row = await privateAgentForSubject(session, subjectId);
  if (!row?.claimed_at) throw new Error("The Founding Human claim could not be loaded");

  const counts = await networkCounts(session);
  const invitedRow = await session.prepare(
    "SELECT COUNT(*) AS count FROM world_agents WHERE referred_by_agent_number = ? AND claimed_at IS NOT NULL",
  ).bind(row.agent_number).first<{ count: number }>();
  const profile = publicProfile(env, row);
  const network = networkProjection(env, counts);
  await incrementMetric(env, row.agent_number, "share_link_issued");
  if (claimed.meta.changes === 1 && row.referred_by_agent_number !== null) {
    await incrementMetric(env, row.referred_by_agent_number, "referral_redemption");
  }

  return {
    ...profile,
    verified_human: true,
    verification_level: "orb",
    protocol_version: "4.0",
    unique_humans_invited: Number(invitedRow?.count ?? 0),
    network,
    share_text: `I’m Founding Human ${profile.display_number} — one of the first unique humans to connect World ID to ChatGPT. Claim your place: ${profile.invite_url}`,
    privacy_notice: "The public card contains only the Founding Human number, cohort, dates, and minimal World ID assurance. It contains no identity, proof, session, nullifier, wallet, or conversation data.",
  };
}

export async function getWorldAgentStatus(env: Env, subjectId: string): Promise<{
  claimed: boolean;
  profile?: ClaimedWorldAgent;
  reserved_number?: string;
  network: WorldAgentNetwork;
}> {
  const session = env.DB.withSession("first-primary");
  const row = await privateAgentForSubject(session, subjectId);
  const counts = await networkCounts(session);
  const network = networkProjection(env, counts);
  if (!row) return { claimed: false, network };
  await incrementMetric(env, row.agent_number, "status_check");
  if (!row.claimed_at) {
    return { claimed: false, reserved_number: displayWorldAgentNumber(row.agent_number), network };
  }
  const invited = await session.prepare(
    "SELECT COUNT(*) AS count FROM world_agents WHERE referred_by_agent_number = ? AND claimed_at IS NOT NULL",
  ).bind(row.agent_number).first<{ count: number }>();
  const profile = publicProfile(env, row);
  return {
    claimed: true,
    profile: {
      ...profile,
      verified_human: true,
      verification_level: "orb",
      protocol_version: "4.0",
      unique_humans_invited: Number(invited?.count ?? 0),
      network,
      share_text: `I’m Founding Human ${profile.display_number} — one of the first unique humans to connect World ID to ChatGPT. Claim your place: ${profile.invite_url}`,
      privacy_notice: "The public card contains no identity, World ID proof, session, nullifier, wallet, or conversation data.",
    },
    network,
  };
}

export function renderWorldAgentClaimPage(
  status: Awaited<ReturnType<typeof getWorldAgentStatus>>,
  formToken: string,
): string {
  const heading = status.claimed
    ? `Founding Human ${escapeHtml(status.profile!.display_number)}`
    : status.reserved_number
      ? `${escapeHtml(status.reserved_number)} is reserved for you`
      : "Claim your place as a Founding Human";
  const action = status.claimed
    ? `<a class="button" href="${escapeHtml(status.profile!.share_url)}">View my public card</a>`
    : `<form method="post" action="/claim-founding-human"><input type="hidden" name="confirmation" value="claim"><input type="hidden" name="form_token" value="${escapeHtml(formToken)}"><button class="button" type="submit">Claim and publish my card</button></form>`;
  const detail = status.claimed
    ? "This verified human has already claimed one permanent place in the network."
    : "Claiming makes your permanent number and minimal Orb · World ID 4.0 assurance public. It does not publish your identity, proof, wallet, session, or ChatGPT conversation.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f9f9f8"><title>${heading} · World ID</title><style>${sharedPageStyles()}.main{width:min(660px,calc(100% - 40px));margin:0 auto;padding:90px 0}.eyebrow{margin:0 0 17px;color:var(--muted);font-size:14px;font-weight:500}.card{padding:clamp(28px,6vw,54px);border:1px solid var(--line);border-radius:24px;background:#fff;box-shadow:0 24px 70px #1818180d}h1{margin:0;font-size:clamp(42px,8vw,68px);line-height:1.04;letter-spacing:-.025em;font-weight:325}.detail{margin:25px 0 30px;color:var(--muted);font-size:17px;line-height:1.6}.facts{display:grid;grid-template-columns:1fr 1fr;margin:0 0 30px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.fact{padding:17px 0}.fact+.fact{padding-left:20px;border-left:1px solid var(--line)}.fact strong,.fact span{display:block}.fact strong{font-weight:500}.fact span{margin-top:4px;color:var(--muted);font-size:12px}form{margin:0}.button{border:0;cursor:pointer}.note{margin:18px 0 0;color:var(--quiet);font-size:12px;line-height:1.5}@media(max-width:520px){.facts{grid-template-columns:1fr}.fact+.fact{padding-left:0;border-left:0;border-top:1px solid var(--line)}}</style></head><body><header class="nav shell"><a class="brand" href="/"><img src="/world-logo.svg" alt="World" width="96" height="24"></a><a class="nav-link" href="/founding-humans">Founding Humans</a></header><main class="main"><article class="card"><p class="eyebrow">World ID</p><h1>${heading}</h1><p class="detail">${detail}</p><div class="facts"><div class="fact"><strong>${escapeHtml(status.reserved_number ?? status.profile?.display_number ?? "Next available")}</strong><span>permanent place</span></div><div class="fact"><strong>${status.network.genesis_claimed} / ${status.network.genesis_limit}</strong><span>Genesis places claimed</span></div></div>${action}<p class="note">This confirmation link expires after 10 minutes and can only claim the Founding Human place associated with the verified ChatGPT connection that created it.</p></article></main></body></html>`;
}

export async function getPublicWorldAgentProfile(env: Env, slug: string): Promise<PublicWorldAgentProfile> {
  if (!WORLD_AGENT_SLUG_PATTERN.test(slug)) throw new PublicError("Founding Human not found", 404);
  const row = await env.DB.prepare(
    "SELECT * FROM world_agents WHERE share_slug = ? AND claimed_at IS NOT NULL",
  ).bind(slug).first<WorldAgentRow>();
  if (!row) throw new PublicError("Founding Human not found", 404);
  return publicProfile(env, row);
}

export async function recordWorldAgentProfileView(env: Env, agentNumber: number): Promise<void> {
  await incrementMetric(env, agentNumber, "profile_view");
}

export async function getPublicWorldAgentNetwork(env: Env): Promise<WorldAgentNetwork & {
  founding_agents: PublicWorldAgentProfile[];
}> {
  const [counts, rows] = await Promise.all([
    networkCounts(env.DB),
    env.DB.prepare(
      `SELECT * FROM world_agents
       WHERE claimed_at IS NOT NULL
       ORDER BY agent_number ASC
       LIMIT ?`,
    ).bind(GENESIS_WORLD_AGENT_LIMIT).all<WorldAgentRow>(),
  ]);
  return {
    ...networkProjection(env, counts),
    founding_agents: rows.results.map((row) => publicProfile(env, row)),
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

function sharedPageStyles(): string {
  return `@font-face{font-family:"World Pro";src:url("/WorldProMVPVF.ttf") format("truetype");font-style:normal;font-weight:100 900;font-display:swap}:root{font-family:"World Pro","Noto Sans",Helvetica,sans-serif;font-weight:325;color:#181818;background:#f9f9f8;--ink:#181818;--blue:#3fdbed;--blue-soft:#ecfbfd;--line:#e1dfda;--muted:#75726f;--quiet:#9d9b96}*{box-sizing:border-box}body{margin:0;min-height:100vh}a{color:inherit}strong{font-weight:500}.shell{width:min(1080px,calc(100% - 40px));margin:0 auto}.nav{display:flex;align-items:center;justify-content:space-between;min-height:72px;border-bottom:1px solid var(--line);font-weight:325}.brand{display:flex;align-items:center;text-decoration:none}.brand img{display:block;width:96px;height:24px}.nav-links{display:flex;align-items:center;gap:24px}.nav-link{font-size:14px;color:var(--muted);text-decoration:none}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 19px;border-radius:999px;background:#181818;color:#fff;text-decoration:none;font-size:14px;font-weight:500}.foot{padding:34px 0 48px;color:var(--quiet);font-size:12px}@media(max-width:620px){.shell{width:min(100% - 26px,1080px)}.button{width:100%}.nav-links .nav-link:first-child{display:none}}`;
}

export function renderWorldAgentProfilePage(profile: PublicWorldAgentProfile, network: WorldAgentNetwork): string {
  const progress = Math.min(100, Math.round((network.genesis_claimed / network.genesis_limit) * 100));
  const claimedDate = new Date(profile.claimed_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#3fdbed"><title>Founding Human ${escapeHtml(profile.display_number)} · World ID</title><meta name="description" content="One of the first unique humans to connect World ID to ChatGPT."><meta property="og:title" content="Founding Human ${escapeHtml(profile.display_number)} · ${escapeHtml(profile.cohort)}"><meta property="og:description" content="One of the first unique humans to connect World ID to ChatGPT. Claim your place as a Founding Human."><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(profile.share_url)}"><style>${sharedPageStyles()}.main{padding:78px 0 54px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:72px;align-items:center}.eyebrow{margin:0 0 18px;color:var(--muted);font-size:14px;font-weight:500}.number{margin:0;font-size:clamp(76px,14vw,148px);line-height:.88;letter-spacing:-.04em;font-weight:325}.lede{max-width:620px;margin:30px 0 0;color:var(--muted);font-size:20px;line-height:1.5}.card{position:relative;overflow:hidden;min-height:430px;padding:28px;border:1px solid #28bdce;border-radius:24px;background:var(--blue);color:#181818;box-shadow:0 28px 70px #1818181f;display:flex;flex-direction:column;justify-content:space-between}.card:before{content:"";position:absolute;width:260px;height:260px;border:1px solid #1818182b;border-radius:50%;right:-100px;top:-80px}.card-top{display:flex;justify-content:space-between;gap:20px;font-size:12px;font-weight:500}.card-number{font-size:69px;line-height:1;letter-spacing:-.035em;font-weight:325}.card-label{margin-top:10px;font-size:17px;font-weight:500}.card-date{margin-top:7px;color:#2d2c2c;font-size:12px}.stats{display:grid;grid-template-columns:repeat(3,1fr);margin:68px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.stat{padding:24px 18px 24px 0}.stat+.stat{padding-left:24px;border-left:1px solid var(--line)}.stat strong{display:block;font-size:24px;letter-spacing:-.02em;font-weight:500}.stat span{display:block;margin-top:5px;color:var(--muted);font-size:12px}.progress-wrap{margin:45px 0}.progress-head{display:flex;justify-content:space-between;gap:20px;margin-bottom:12px;font-size:13px;font-weight:500}.progress{height:7px;background:#e1dfda}.progress i{display:block;width:${progress}%;height:100%;background:var(--blue)}.cta{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:center;margin-top:44px;padding:27px;border:1px solid var(--line);border-radius:20px;background:#fff}.cta h2{margin:0 0 7px;font-size:25px;letter-spacing:-.02em;font-weight:325}.cta p{margin:0;color:var(--muted);font-size:14px;line-height:1.5}.prompt{display:block;margin-top:12px;color:#2d2c2c;font:500 13px/1.45 ui-monospace,SFMono-Regular,monospace}@media(max-width:820px){.layout{grid-template-columns:1fr}.card{width:min(390px,100%)}.stats{grid-template-columns:1fr}.stat+.stat{padding-left:0;border-left:0;border-top:1px solid var(--line)}.cta{grid-template-columns:1fr}}</style></head><body><header class="nav shell"><a class="brand" href="/"><img src="/world-logo.svg" alt="World" width="96" height="24"></a><div class="nav-links"><a class="nav-link" href="/founding-humans">Founding Humans</a></div></header><main class="main shell"><div class="layout"><section><p class="eyebrow">Founding Human</p><h1 class="number">${escapeHtml(profile.display_number)}</h1><p class="lede">One of the first unique humans to connect World ID to ChatGPT.</p></section><article class="card" aria-label="Founding Human card"><div class="card-top"><span>FOUNDING HUMAN</span><span>ORB VERIFIED</span></div><div><div class="card-number">${escapeHtml(profile.display_number)}</div><div class="card-label">${escapeHtml(profile.cohort)}</div><div class="card-date">Verified since ${escapeHtml(claimedDate)}</div></div></article></div><section class="stats" aria-label="World ID facts"><div class="stat"><strong>${network.claimed_humans}</strong><span>Founding Humans</span></div><div class="stat"><strong>${network.genesis_claimed} / ${network.genesis_limit}</strong><span>Genesis places claimed</span></div><div class="stat"><strong>4.0</strong><span>World ID protocol</span></div></section><section class="progress-wrap"><div class="progress-head"><span>Genesis 100 progress</span><span>${progress}%</span></div><div class="progress"><i></i></div><p class="lede" style="font-size:15px;margin-top:16px">${escapeHtml(network.next_capability)}</p></section><section class="cta"><div><h2>Claim your place.</h2><p>Add World ID in ChatGPT, verify privately, then ask:</p><span class="prompt">Claim my place as a Founding Human.</span></div><a class="button" href="/#setup">Set up in ChatGPT</a></section></main><footer class="foot shell">Public card contains no identity, World ID proof, session, wallet, or conversation data.</footer></body></html>`;
}

export function renderWorldAgentNetworkPage(network: WorldAgentNetwork & { founding_agents: PublicWorldAgentProfile[] }): string {
  const progress = Math.min(100, Math.round((network.genesis_claimed / network.genesis_limit) * 100));
  const cards = network.founding_agents.length === 0
    ? `<p class="empty">No public claims yet. The earliest verified testers already have their numbers reserved.</p>`
    : network.founding_agents.map((agent) => `<a class="slot" href="${escapeHtml(agent.share_url)}"><span>${escapeHtml(agent.display_number)}</span><small>${escapeHtml(agent.cohort)}</small></a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f9f9f8"><title>Founding Humans · World ID</title><meta name="description" content="The founding registry of unique humans who connected World ID to ChatGPT."><style>${sharedPageStyles()}.hero{padding:95px 0 65px}.eyebrow{margin:0 0 20px;color:var(--muted);font-size:14px;font-weight:500}h1{max-width:850px;margin:0;font-size:clamp(60px,10vw,104px);line-height:1;letter-spacing:-.025em;font-weight:325}.lede{max-width:690px;margin:28px 0 0;color:var(--muted);font-size:19px;line-height:1.55}.meter{margin:60px 0 0;padding:26px;border:1px solid var(--line);border-radius:20px;background:#fff}.meter-head{display:flex;justify-content:space-between;gap:18px;font-weight:500}.bar{height:8px;margin:16px 0;background:var(--line)}.bar i{display:block;width:${progress}%;height:100%;background:var(--blue)}.meter p{margin:0;color:var(--muted);font-size:14px}.registry{padding:64px 0;border-top:1px solid var(--line)}.registry-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:28px}.registry h2{margin:0;font-size:35px;letter-spacing:-.02em;font-weight:325}.registry-head span{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(5,1fr);border-top:1px solid var(--ink);border-left:1px solid var(--line)}.slot{min-height:112px;padding:18px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff;text-decoration:none;display:flex;flex-direction:column;justify-content:space-between}.slot:hover{background:var(--blue-soft)}.slot span{font-size:24px;font-weight:500;letter-spacing:-.02em}.slot small{color:var(--muted)}.empty{padding:40px;border:1px solid var(--line);border-radius:20px;background:#fff;color:var(--muted)}.cta{display:flex;align-items:center;justify-content:space-between;gap:30px;padding:34px 0 78px;border-top:1px solid var(--line)}.cta h2{margin:0 0 8px;font-size:29px;font-weight:325}.cta p{margin:0;color:var(--muted)}@media(max-width:820px){.grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:620px){.grid{grid-template-columns:repeat(2,1fr)}.cta{align-items:flex-start;flex-direction:column}}</style></head><body><header class="nav shell"><a class="brand" href="/"><img src="/world-logo.svg" alt="World" width="96" height="24"></a><div class="nav-links"><span class="nav-link">Founding Humans</span></div></header><main><section class="hero shell"><p class="eyebrow">World ID</p><h1>Founding humans, verified.</h1><p class="lede">A public registry for the first unique humans connecting World ID to ChatGPT. Each verified human receives one permanent number; no identity or World ID material appears here.</p><div class="meter"><div class="meter-head"><span>Genesis 100</span><span>${network.genesis_claimed} / ${network.genesis_limit}</span></div><div class="bar"><i></i></div><p>${escapeHtml(network.next_capability)}</p></div></section><section class="registry shell"><div class="registry-head"><h2>Founding Humans</h2><span>${network.claimed_humans} public claim${network.claimed_humans === 1 ? "" : "s"}</span></div><div class="grid">${cards}</div></section><section class="cta shell"><div><h2>Become a Founding Human.</h2><p>Existing verified testers have the earliest numbers reserved.</p></div><a class="button" href="/#setup">Set up in ChatGPT</a></section></main><footer class="foot shell">World ID · Powered by World ID 4.0</footer></body></html>`;
}
