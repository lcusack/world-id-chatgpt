export const PARTNER_IDS = ["agentmail", "maitre"] as const;
export type PartnerId = (typeof PARTNER_IDS)[number];

export function partnerHubCallbackPath(instanceName: string): string {
  return `agents/partner-hub/${encodeURIComponent(instanceName)}/callback`;
}

export function shouldRestartPartnerConnection(state: string | undefined): boolean {
  return state === "authenticating" || state === "failed";
}

export function supportsFormElicitation(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const elicitation = (capabilities as Record<string, unknown>).elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) return false;
  const modes = elicitation as Record<string, unknown>;
  return Object.keys(modes).length === 0 || ("form" in modes && modes.form !== undefined);
}

export function isUnauthorizedPartnerError(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") return /\b(?:unauthorized|unauthenticated)\b|(?:^|\D)401(?:\D|$)/iu.test(value);
  if (value instanceof Error) return isUnauthorizedPartnerError(value.message, depth + 1);
  if (Array.isArray(value)) return value.some((item) => isUnauthorizedPartnerError(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>)
    .some((item) => isUnauthorizedPartnerError(item, depth + 1));
}

export const PARTNERS: Record<PartnerId, { name: string; mcpUrl: string }> = {
  agentmail: { name: "AgentMail", mcpUrl: "https://mcp.agentmail.to/mcp" },
  maitre: { name: "Maître", mcpUrl: "https://www.maitre.fun/mcp" },
};

const READ_TOOLS: Record<PartnerId, ReadonlySet<string>> = {
  agentmail: new Set([
    "list_organizations", "list_inboxes", "search_inboxes", "get_inbox",
    "list_messages", "search_messages", "get_message", "get_thread",
  ]),
  maitre: new Set(["list_seats", "my_reservations", "wait_for_verification"]),
};

const WRITE_TOOLS: Record<PartnerId, ReadonlySet<string>> = {
  agentmail: new Set([
    "select_organization", "create_inbox", "create_draft", "update_draft",
    "send_message", "send_draft", "reply_to_message", "forward_message",
  ]),
  maitre: new Set(["claim_seat", "cancel_reservation"]),
};

export function isPartnerId(value: string): value is PartnerId {
  return (PARTNER_IDS as readonly string[]).includes(value);
}

export function partnerToolKind(provider: PartnerId, tool: string): "read" | "write" | null {
  if (READ_TOOLS[provider].has(tool)) return "read";
  if (WRITE_TOOLS[provider].has(tool)) return "write";
  return null;
}

type DownstreamToolResult = {
  content: unknown;
  isError?: boolean;
  structuredContent?: unknown;
};

export type SanitizedPartnerToolResult = {
  isError?: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

export function sanitizePartnerToolResult(result: DownstreamToolResult): SanitizedPartnerToolResult {
  const items = Array.isArray(result.content) ? result.content : [];
  const content = items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== "text" || typeof candidate.text !== "string") return [];
    return [{ type: "text" as const, text: candidate.text.slice(0, 100_000) }];
  }).slice(0, 20);
  return {
    ...(result.isError === true ? { isError: true } : {}),
    content: content.length > 0
      ? content
      : [{ type: "text", text: result.isError === true ? "The provider could not complete the request." : "The provider completed the request." }],
    ...(result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? { structuredContent: result.structuredContent as Record<string, unknown> }
      : {}),
  };
}
