const WORLD_ID_MCP_URL = "https://auth.world.org/mcp";
const CATALOG_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BENEFITS = 100;

export type OfficialWorldIdBenefit = {
  name: string;
  description: string;
  appUrl: string;
};

export class WorldIdBenefitCatalogError extends Error {
  readonly code: "timeout" | "upstream" | "oversized" | "malformed";

  constructor(code: WorldIdBenefitCatalogError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorldIdBenefitCatalogError";
    this.code = code;
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function publicHttpsUrl(value: unknown): string | null {
  const raw = boundedString(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new WorldIdBenefitCatalogError("oversized", "World ID returned an oversized benefit catalog");
  }
  if (!response.body) throw new WorldIdBenefitCatalogError("malformed", "World ID returned an empty benefit catalog");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WorldIdBenefitCatalogError("oversized", "World ID returned an oversized benefit catalog");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID returned malformed benefit catalog data", { cause: error });
  }
}

function parseBenefit(value: unknown): OfficialWorldIdBenefit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const name = boundedString(candidate.name, 160);
  const description = boundedString(candidate.description, 1_000);
  const appUrl = publicHttpsUrl(candidate.appUrl);
  return name && description && appUrl ? { name, description, appUrl } : null;
}

function parseCatalog(value: unknown): OfficialWorldIdBenefit[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID returned an invalid benefit catalog envelope");
  }
  const envelope = value as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID returned an invalid benefit catalog result");
  }
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID omitted structured benefit catalog data");
  }
  const benefits = (structured as Record<string, unknown>).benefits;
  if (benefits === null) return [];
  if (!Array.isArray(benefits) || benefits.length > MAX_BENEFITS) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID returned an invalid benefit list");
  }
  const parsed = benefits.map(parseBenefit);
  if (parsed.some((benefit) => benefit === null)) {
    throw new WorldIdBenefitCatalogError("malformed", "World ID returned an invalid benefit listing");
  }
  const unique = new Map<string, OfficialWorldIdBenefit>();
  for (const benefit of parsed as OfficialWorldIdBenefit[]) unique.set(benefit.appUrl, benefit);
  return [...unique.values()];
}

export async function fetchOfficialWorldIdBenefits(
  fetchImpl: typeof fetch = fetch,
): Promise<OfficialWorldIdBenefit[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const response = await fetchImpl(WORLD_ID_MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "World-ID-ChatGPT/0.1 (+https://world-id-chatgpt.foundry-world.workers.dev)",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "world-id-benefits",
        method: "tools/call",
        params: { name: "get_benefits", arguments: {} },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorldIdBenefitCatalogError("upstream", `World ID benefit catalog request failed (${response.status})`);
    }
    return parseCatalog(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof WorldIdBenefitCatalogError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WorldIdBenefitCatalogError("timeout", "World ID benefit catalog request timed out", { cause: error });
    }
    throw new WorldIdBenefitCatalogError("upstream", "World ID benefit catalog request failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
