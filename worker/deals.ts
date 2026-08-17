import type { Env } from "./types";

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCTS = 250;
const STORE_TIMEOUT_MS = 8_000;
const UNIQUE_HUMAN_COLLECTION_TAG = "collection:Unique human of SF";

export const UNIQUE_HUMAN_DEAL_IDS = [
  "unique-human-sf-15",
  "cyto-liftoff-exclusive",
] as const;

export const CLAIMABLE_DEAL_IDS = ["unique-human-sf-15"] as const;

export type UniqueHumanDealId = (typeof UNIQUE_HUMAN_DEAL_IDS)[number];
export type ClaimableDealId = (typeof CLAIMABLE_DEAL_IDS)[number];

type ShopifyVariant = {
  title: string;
  price: string;
  available: boolean;
};

type ShopifyProduct = {
  title: string;
  handle: string;
  tags: string[];
  variants: ShopifyVariant[];
};

export type DealProduct = {
  title: string;
  price: string;
  currency: "USD";
  available: boolean;
  available_options: string[];
  product_url: string;
};

export type DealSummary = {
  id: UniqueHumanDealId;
  title: string;
  benefit: string;
  kind: "discount" | "exclusive_access";
  availability: "available" | "sold_out";
  eligible_product_count: number;
  in_stock_product_count: number;
  store_url: string;
  requires_store_world_id_verification: true;
  chatgpt_claim_available: boolean;
};

export type DealDetail = DealSummary & {
  description: string;
  products: DealProduct[];
  handoff_instructions: string;
};

export type UniqueHumanDeals = {
  as_of: string;
  store_name: "Human Required";
  store_url: string;
  deals: DealSummary[];
  connection_notice: string;
};

export type DealClaimTarget = {
  dealId: ClaimableDealId;
  availability: "available" | "sold_out";
  productHandles: string[];
  redirectPath: string;
};

export class DealCatalogError extends Error {
  readonly code: "invalid_origin" | "timeout" | "upstream" | "oversized" | "malformed";

  constructor(code: DealCatalogError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DealCatalogError";
    this.code = code;
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function parseVariant(value: unknown): ShopifyVariant | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const title = boundedString(candidate.title, 100);
  const price = boundedString(candidate.price, 30);
  if (!title || !price || !/^\d+(?:\.\d{1,2})?$/u.test(price) || typeof candidate.available !== "boolean") return null;
  return { title, price, available: candidate.available };
}

function parseProduct(value: unknown): ShopifyProduct | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const title = boundedString(candidate.title, 160);
  const handle = boundedString(candidate.handle, 160);
  if (!title || !handle || !/^[a-z0-9][a-z0-9-]*$/u.test(handle)) return null;
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.map((tag) => boundedString(tag, 120)).filter((tag): tag is string => tag !== null).slice(0, 50)
    : [];
  const variants = Array.isArray(candidate.variants)
    ? candidate.variants.map(parseVariant).filter((variant): variant is ShopifyVariant => variant !== null).slice(0, 100)
    : [];
  return variants.length > 0 ? { title, handle, tags, variants } : null;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_CATALOG_BYTES) throw new DealCatalogError("oversized", "Human Required returned an oversized catalog");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new DealCatalogError("oversized", "Human Required returned an oversized catalog");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function storeOrigin(env: Env): URL {
  const origin = new URL(env.HUMAN_REQUIRED_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    throw new DealCatalogError("invalid_origin", "Invalid Human Required store origin");
  }
  return origin;
}

async function getCatalog(env: Env): Promise<ShopifyProduct[]> {
  const origin = storeOrigin(env);
  const url = new URL(`/products.json?limit=${MAX_PRODUCTS}`, origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "World-ID-Deals/1.0 (+https://world-id-chatgpt.foundry-world.workers.dev)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DealCatalogError("upstream", `Human Required catalog request failed (${response.status})`);
    }
    const raw = await readBoundedText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DealCatalogError("malformed", "Human Required returned malformed catalog data");
    }
    const products = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).products)
      ? (parsed as { products: unknown[] }).products
      : null;
    if (!products) throw new DealCatalogError("malformed", "Human Required returned an invalid catalog");
    return products.slice(0, MAX_PRODUCTS).map(parseProduct).filter((product): product is ShopifyProduct => product !== null);
  } catch (error) {
    if (error instanceof DealCatalogError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DealCatalogError("timeout", "Human Required catalog request timed out", { cause: error });
    }
    throw new DealCatalogError("upstream", "Human Required catalog request failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function productUrl(origin: URL, handle: string): string {
  return new URL(`/products/${encodeURIComponent(handle)}`, origin).toString();
}

function displayPrice(variants: ShopifyVariant[]): string {
  const prices = variants.map((variant) => Number(variant.price)).filter(Number.isFinite);
  if (prices.length === 0) return "Price unavailable";
  const low = Math.min(...prices).toFixed(2);
  const high = Math.max(...prices).toFixed(2);
  return low === high ? `$${low}` : `$${low}–$${high}`;
}

function publicProduct(origin: URL, product: ShopifyProduct): DealProduct {
  return {
    title: product.title,
    price: displayPrice(product.variants),
    currency: "USD",
    available: product.variants.some((variant) => variant.available),
    available_options: product.variants.filter((variant) => variant.available).map((variant) => variant.title),
    product_url: productUrl(origin, product.handle),
  };
}

function summary(
  origin: URL,
  id: UniqueHumanDealId,
  products: ShopifyProduct[],
): DealSummary {
  const inStockCount = products.filter((product) => product.variants.some((variant) => variant.available)).length;
  if (id === "unique-human-sf-15") {
    return {
      id,
      title: "15% off Unique Human of SF",
      benefit: "15% off eligible Unique Human of SF products",
      kind: "discount",
      availability: inStockCount > 0 ? "available" : "sold_out",
      eligible_product_count: products.length,
      in_stock_product_count: inStockCount,
      store_url: new URL("/#shop", origin).toString(),
      requires_store_world_id_verification: true,
      chatgpt_claim_available: true,
    };
  }
  return {
    id,
    title: "Cyto Liftoff Sneaker",
    benefit: "Access to a verified-human-only product",
    kind: "exclusive_access",
    availability: inStockCount > 0 ? "available" : "sold_out",
    eligible_product_count: products.length,
    in_stock_product_count: inStockCount,
    store_url: products[0] ? productUrl(origin, products[0].handle) : new URL("/", origin).toString(),
    requires_store_world_id_verification: true,
    chatgpt_claim_available: false,
  };
}

function productsForDeal(catalog: ShopifyProduct[], id: UniqueHumanDealId): ShopifyProduct[] {
  if (id === "unique-human-sf-15") return catalog.filter((product) => product.tags.includes(UNIQUE_HUMAN_COLLECTION_TAG));
  return catalog.filter((product) => product.handle === "cytoshift" && product.tags.includes("world-id-gated"));
}

export async function listUniqueHumanDeals(env: Env): Promise<UniqueHumanDeals> {
  const origin = storeOrigin(env);
  const catalog = await getCatalog(env);
  return {
    as_of: new Date().toISOString(),
    store_name: "Human Required",
    store_url: origin.toString(),
    deals: UNIQUE_HUMAN_DEAL_IDS
      .map((id) => summary(origin, id, productsForDeal(catalog, id)))
      .filter((deal) => deal.eligible_product_count > 0),
    connection_notice: "For the 15% offer, ask World ID to create a claim link that carries this verified-human entitlement into Shopify without a second proof. Ordinary store links still use Human Required's own World ID check.",
  };
}

export async function getUniqueHumanDeal(env: Env, id: UniqueHumanDealId): Promise<DealDetail> {
  const origin = storeOrigin(env);
  const catalog = await getCatalog(env);
  const matchedProducts = productsForDeal(catalog, id);
  if (matchedProducts.length === 0) throw new Error("This deal is not currently present in the Human Required catalog");
  const deal = summary(origin, id, matchedProducts);
  const description = id === "unique-human-sf-15"
    ? "Orb-verified users receive 15% off the Human Required Unique Human of SF range."
    : "The Cyto Liftoff sneaker is available exclusively to verified humans while inventory lasts.";
  return {
    ...deal,
    description,
    products: matchedProducts.map((product) => publicProduct(origin, product)),
    handoff_instructions: id === "unique-human-sf-15"
      ? "Ask World ID to create a claim link. Opening that short-lived link applies the verified-human discount in Shopify without a second World ID proof."
      : "Open the store link and complete Human Required's World ID check there to unlock or claim the offer.",
  };
}

export async function getDealClaimTarget(env: Env, id: ClaimableDealId): Promise<DealClaimTarget> {
  const catalog = await getCatalog(env);
  const products = productsForDeal(catalog, id);
  return {
    dealId: id,
    availability: products.some((product) => product.variants.some((variant) => variant.available)) ? "available" : "sold_out",
    productHandles: products.map((product) => product.handle),
    redirectPath: "/#shop",
  };
}
