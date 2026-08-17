import { openJson, randomToken, sealJson, sha256 } from "./crypto.ts";
import { getDealClaimTarget, type ClaimableDealId } from "./deals.ts";
import type { Env, HumanDealClaimRow } from "./types.ts";

const CLAIM_TTL_SECONDS = 5 * 60;
const DISCOUNT_TTL_SECONDS = 15 * 60;
const PROCESSING_LEASE_SECONDS = 30;
const SHOPIFY_TIMEOUT_MS = 8_000;
const MAX_SHOPIFY_RESPONSE_BYTES = 512 * 1024;
const SHOPIFY_PRODUCT_LIMIT = 250;
const SHOPIFY_API_VERSION_PATTERN = /^\d{4}-(?:01|04|07|10)$/u;
const SHOPIFY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u;

type ClaimSecret = { value: string };

type ShopifyProductNode = {
  id: string;
  handle: string;
};

type ShopifyGraphQlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message?: unknown }>;
};

type ShopifyConfig = {
  domain: string;
  version: string;
  credentials:
    | { kind: "client_credentials"; clientId: string; clientSecret: string }
    | { kind: "access_token"; accessToken: string };
};

type ShopifyTokenResponse = {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
};

type ShopifyProductsData = {
  products?: { nodes?: unknown };
};

type ShopifyDiscountData = {
  discountCodeBasicCreate?: {
    codeDiscountNode?: { id?: unknown } | null;
    userErrors?: Array<{ message?: unknown; code?: unknown }>;
  };
};

export type ClaimLink = {
  deal_id: ClaimableDealId;
  claim_url: string;
  expires_at: string;
  discount: "15%";
  store_name: "Human Required";
  security_notice: string;
};

export class ClaimError extends Error {
  readonly code: "not_configured" | "invalid" | "expired" | "busy" | "shopify";
  readonly status: number;

  constructor(code: ClaimError["code"], message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaimError";
    this.code = code;
    this.status = status;
  }
}

function shopifyConfig(env: Env): ShopifyConfig {
  const domain = env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase();
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || "2026-07";
  const accessToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  const clientId = env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!domain || (!accessToken && (!clientId || !clientSecret))) {
    throw new ClaimError("not_configured", "Human Required claim links are not active yet", 503);
  }
  if (!SHOPIFY_DOMAIN_PATTERN.test(domain) || !SHOPIFY_API_VERSION_PATTERN.test(version)) {
    throw new ClaimError("not_configured", "Human Required claim links are not configured correctly", 503);
  }
  if (accessToken) return { domain, version, credentials: { kind: "access_token", accessToken } };
  return {
    domain,
    version,
    credentials: { kind: "client_credentials", clientId: clientId!, clientSecret: clientSecret! },
  };
}

function parseProductNode(value: unknown): ShopifyProductNode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || !/^gid:\/\/shopify\/Product\/\d+$/u.test(candidate.id)
    || typeof candidate.handle !== "string"
    || !/^[a-z0-9][a-z0-9-]*$/u.test(candidate.handle)
  ) return null;
  return { id: candidate.id, handle: candidate.handle };
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_SHOPIFY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ClaimError("shopify", "Shopify returned an oversized response", 502);
  }
  if (!response.body) throw new ClaimError("shopify", "Shopify returned an empty response", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SHOPIFY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ClaimError("shopify", "Shopify returned an oversized response", 502);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ClaimError("shopify", "Shopify returned an invalid response", 502, { cause: error });
  }
}

async function acquireShopifyAccessToken(config: ShopifyConfig): Promise<string> {
  if (config.credentials.kind === "access_token") return config.credentials.accessToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.credentials.clientId,
      client_secret: config.credentials.clientSecret,
    });
    const response = await fetch(`https://${config.domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "World-ID-Claims/1.0 (+https://world-id-chatgpt.foundry-world.workers.dev)",
      },
      body,
      signal: controller.signal,
    });
    const result = await readBoundedJson<ShopifyTokenResponse>(response);
    if (!response.ok) throw new ClaimError("shopify", "Shopify rejected the app credentials", 502);
    if (typeof result.access_token !== "string" || result.access_token.length < 16 || result.access_token.length > 512) {
      throw new ClaimError("shopify", "Shopify returned an invalid app access token", 502);
    }
    const scopes = typeof result.scope === "string" ? new Set(result.scope.split(",").map((scope) => scope.trim())) : new Set<string>();
    if (!scopes.has("read_products") || !scopes.has("write_discounts")) {
      throw new ClaimError("not_configured", "The Shopify app is missing its product or discount permission", 503);
    }
    return result.access_token;
  } catch (error) {
    if (error instanceof ClaimError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ClaimError("shopify", "Shopify authentication did not respond in time", 504, { cause: error });
    }
    throw new ClaimError("shopify", "Shopify authentication could not be reached", 502, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function shopifyGraphQl<T>(config: ShopifyConfig, accessToken: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${config.domain}/admin/api/${config.version}/graphql.json`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-shopify-access-token": accessToken,
        "user-agent": "World-ID-Claims/1.0 (+https://world-id-chatgpt.foundry-world.workers.dev)",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const envelope = await readBoundedJson<ShopifyGraphQlEnvelope<T>>(response);
    if (!response.ok) throw new ClaimError("shopify", `Shopify rejected the claim request (${response.status})`, 502);
    const graphQlMessage = envelope.errors?.find((error) => typeof error.message === "string")?.message;
    if (typeof graphQlMessage === "string") throw new ClaimError("shopify", "Shopify rejected the claim request", 502);
    if (!envelope.data) throw new ClaimError("shopify", "Shopify returned no claim data", 502);
    return envelope.data;
  } catch (error) {
    if (error instanceof ClaimError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ClaimError("shopify", "Shopify did not respond in time", 504, { cause: error });
    }
    throw new ClaimError("shopify", "Shopify could not be reached", 502, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function eligibleShopifyProductIds(config: ShopifyConfig, accessToken: string, handles: string[]): Promise<string[]> {
  const data = await shopifyGraphQl<ShopifyProductsData>(config, accessToken, `
    query WorldIdClaimProducts($first: Int!) {
      products(first: $first) {
        nodes { id handle }
      }
    }
  `, { first: SHOPIFY_PRODUCT_LIMIT });
  const nodes = Array.isArray(data.products?.nodes)
    ? data.products.nodes.map(parseProductNode).filter((node): node is ShopifyProductNode => node !== null)
    : [];
  const expected = new Set(handles);
  const productIds = nodes.filter((node) => expected.has(node.handle)).map((node) => node.id);
  if (productIds.length !== expected.size) {
    throw new ClaimError("shopify", "The eligible Human Required products do not match the Shopify catalog", 502);
  }
  return productIds;
}

async function createShopifyDiscount(
  env: Env,
  code: string,
  handles: string[],
  expiresAt: number,
): Promise<string> {
  const config = shopifyConfig(env);
  const accessToken = await acquireShopifyAccessToken(config);
  const productIds = await eligibleShopifyProductIds(config, accessToken, handles);
  const startsAt = new Date((Math.floor(Date.now() / 1000) - 30) * 1000).toISOString();
  const data = await shopifyGraphQl<ShopifyDiscountData>(config, accessToken, `
    mutation CreateWorldIdDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { code message }
      }
    }
  `, {
    input: {
      title: "World ID verified-human claim",
      code,
      startsAt,
      endsAt: new Date(expiresAt * 1000).toISOString(),
      context: { all: "ALL" },
      customerGets: {
        value: { percentage: 0.15 },
        items: { products: { productsToAdd: productIds } },
      },
      usageLimit: 1,
      appliesOncePerCustomer: true,
    },
  });
  const result = data.discountCodeBasicCreate;
  const firstError = result?.userErrors?.find((error) => typeof error.message === "string");
  if (firstError) {
    const message = String(firstError.message).toLowerCase();
    if (message.includes("already") || message.includes("taken")) return "existing-code";
    throw new ClaimError("shopify", "Shopify could not create this verified-human discount", 502);
  }
  const id = result?.codeDiscountNode?.id;
  if (typeof id !== "string" || !id.startsWith("gid://shopify/DiscountCodeNode/")) {
    throw new ClaimError("shopify", "Shopify did not create the verified-human discount", 502);
  }
  return id;
}

function claimUrl(env: Env, token: string): string {
  return new URL(`/claim/${encodeURIComponent(token)}`, env.PUBLIC_ORIGIN).toString();
}

function discountUrl(env: Env, code: string, targetPath: string): string {
  const origin = new URL(env.HUMAN_REQUIRED_ORIGIN);
  const url = new URL(`/discount/${encodeURIComponent(code)}`, origin);
  url.searchParams.set("redirect", targetPath);
  return url.toString();
}

async function decryptSecret(env: Env, ciphertext: string, iv: string): Promise<string> {
  const secret = await openJson<ClaimSecret>({ ciphertext, iv }, env.DATA_ENCRYPTION_KEY);
  if (typeof secret.value !== "string" || secret.value.length < 16 || secret.value.length > 128) {
    throw new ClaimError("invalid", "This claim link is invalid", 400);
  }
  return secret.value;
}

function publicClaim(env: Env, row: HumanDealClaimRow, ticket: string): ClaimLink {
  const activeUntil = row.status === "ready" && row.discount_expires_at
    ? row.discount_expires_at
    : row.ticket_expires_at;
  return {
    deal_id: "unique-human-sf-15",
    claim_url: claimUrl(env, ticket),
    expires_at: new Date(activeUntil * 1000).toISOString(),
    discount: "15%",
    store_name: "Human Required",
    security_notice: "This short-lived link contains no World ID proof, session ID, wallet, or personal information.",
  };
}

async function reusableClaim(env: Env, subjectId: string, now: number): Promise<ClaimLink | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM human_deal_claims
      WHERE subject_id = ? AND deal_id = 'unique-human-sf-15'
        AND ((status IN ('pending', 'processing') AND ticket_expires_at > ?)
          OR (status = 'ready' AND discount_expires_at > ?))
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(subjectId, now, now).first<HumanDealClaimRow>();
  if (!row) return null;
  const ticket = await decryptSecret(env, row.ticket_ciphertext, row.ticket_iv);
  return publicClaim(env, row, ticket);
}

export async function createHumanDealClaim(
  env: Env,
  subjectId: string,
  dealId: ClaimableDealId,
): Promise<ClaimLink> {
  shopifyConfig(env);
  const now = Math.floor(Date.now() / 1000);
  const existing = await reusableClaim(env, subjectId, now);
  if (existing) return existing;

  const target = await getDealClaimTarget(env, dealId);
  if (target.availability !== "available" || target.productHandles.length === 0) {
    throw new ClaimError("invalid", "This Human Required deal is not currently available", 409);
  }
  const ticket = randomToken(32);
  const ticketHash = await sha256(`human-deal-claim:${ticket}`);
  const discountCode = `HUMAN-${randomToken(15).replaceAll("_", "A").replaceAll("-", "B").toUpperCase()}`;
  const [sealedTicket, sealedCode] = await Promise.all([
    sealJson({ value: ticket } satisfies ClaimSecret, env.DATA_ENCRYPTION_KEY),
    sealJson({ value: discountCode } satisfies ClaimSecret, env.DATA_ENCRYPTION_KEY),
  ]);
  const expiresAt = now + CLAIM_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO human_deal_claims (
      ticket_hash, ticket_ciphertext, ticket_iv, subject_id, deal_id, target_path,
      discount_code_ciphertext, discount_code_iv, status, created_at, ticket_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    ticketHash,
    sealedTicket.ciphertext,
    sealedTicket.iv,
    subjectId,
    dealId,
    target.redirectPath,
    sealedCode.ciphertext,
    sealedCode.iv,
    now,
    expiresAt,
  ).run();
  const row: HumanDealClaimRow = {
    ticket_hash: ticketHash,
    ticket_ciphertext: sealedTicket.ciphertext,
    ticket_iv: sealedTicket.iv,
    subject_id: subjectId,
    deal_id: dealId,
    target_path: target.redirectPath,
    discount_code_ciphertext: sealedCode.ciphertext,
    discount_code_iv: sealedCode.iv,
    status: "pending",
    shopify_discount_id: null,
    last_error_code: null,
    created_at: now,
    ticket_expires_at: expiresAt,
    discount_expires_at: null,
    redeemed_at: null,
  };
  return publicClaim(env, row, ticket);
}

export async function redeemHumanDealClaim(env: Env, ticket: string): Promise<string> {
  shopifyConfig(env);
  if (!/^[A-Za-z0-9_-]{40,64}$/u.test(ticket)) throw new ClaimError("invalid", "This claim link is invalid", 400);
  const ticketHash = await sha256(`human-deal-claim:${ticket}`);
  const now = Math.floor(Date.now() / 1000);
  let row = await env.DB.prepare("SELECT * FROM human_deal_claims WHERE ticket_hash = ?")
    .bind(ticketHash)
    .first<HumanDealClaimRow>();
  if (!row) throw new ClaimError("invalid", "This claim link is invalid", 404);

  const code = await decryptSecret(env, row.discount_code_ciphertext, row.discount_code_iv);
  if (row.status === "ready") {
    if (!row.discount_expires_at || row.discount_expires_at <= now) {
      throw new ClaimError("expired", "This verified-human discount has expired", 410);
    }
    return discountUrl(env, code, row.target_path);
  }
  if (row.ticket_expires_at <= now) throw new ClaimError("expired", "This claim link has expired", 410);
  if (row.status === "processing" && (!row.redeemed_at || row.redeemed_at > now - PROCESSING_LEASE_SECONDS)) {
    throw new ClaimError("busy", "This claim is already being prepared. Try again in a moment", 409);
  }
  if (row.status === "failed") throw new ClaimError("shopify", "This claim could not be prepared", 502);

  const locked = await env.DB.prepare(
    `UPDATE human_deal_claims SET status = 'processing', redeemed_at = ?, last_error_code = NULL
      WHERE ticket_hash = ? AND ticket_expires_at > ?
        AND (status = 'pending' OR (status = 'processing' AND redeemed_at <= ?))`,
  ).bind(now, ticketHash, now, now - PROCESSING_LEASE_SECONDS).run();
  if (locked.meta.changes !== 1) throw new ClaimError("busy", "This claim is already being prepared. Try again in a moment", 409);

  try {
    const target = await getDealClaimTarget(env, row.deal_id);
    const discountExpiresAt = now + DISCOUNT_TTL_SECONDS;
    const discountId = await createShopifyDiscount(env, code, target.productHandles, discountExpiresAt);
    await env.DB.prepare(
      "UPDATE human_deal_claims SET status = 'ready', shopify_discount_id = ?, discount_expires_at = ?, last_error_code = NULL WHERE ticket_hash = ? AND status = 'processing'",
    ).bind(discountId, discountExpiresAt, ticketHash).run();
    return discountUrl(env, code, row.target_path);
  } catch (error) {
    const codeValue = error instanceof ClaimError ? error.code : "shopify";
    await env.DB.prepare(
      "UPDATE human_deal_claims SET status = 'pending', redeemed_at = NULL, last_error_code = ? WHERE ticket_hash = ? AND status = 'processing'",
    ).bind(codeValue, ticketHash).run();
    throw error;
  }
}

export async function purgeExpiredClaims(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  await env.DB.prepare(
    "DELETE FROM human_deal_claims WHERE created_at < ? AND ticket_expires_at < ?",
  ).bind(cutoff, Math.floor(Date.now() / 1000)).run();
}
