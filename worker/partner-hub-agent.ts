import { Agent, DurableObjectOAuthClientProvider } from "agents";
import {
  PARTNER_IDS,
  PARTNERS,
  isUnauthorizedPartnerError,
  partnerHubCallbackPath,
  partnerToolKind,
  sanitizePartnerToolResult,
  shouldRestartPartnerConnection,
  type PartnerId,
} from "./partner-registry";

export type PartnerConnectionStatus = {
  provider: PartnerId;
  name: string;
  state: "not_connected" | "authenticating" | "connecting" | "connected" | "discovering" | "ready" | "failed";
  error: string | null;
};

export type PartnerConnectResult = PartnerConnectionStatus & {
  connectUrl?: string;
};

export type PartnerToolSummary = {
  name: string;
  title: string | null;
  description: string | null;
  kind: "read" | "write";
  inputSchema: Record<string, unknown> | null;
};

type PendingPartnerActionRow = {
  provider: string;
  tool: string;
  args_json: string;
};

function publicTool(
  tool: { name: string; title?: string; description?: string; inputSchema?: unknown },
  provider: PartnerId,
): PartnerToolSummary | null {
  const kind = partnerToolKind(provider, tool.name);
  if (!kind) return null;
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
    ? tool.inputSchema as Record<string, unknown>
    : null;
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : null,
    description: typeof tool.description === "string" ? tool.description : null,
    kind,
    inputSchema,
  };
}

export class PartnerHubAgent extends Agent<Cloudflare.Env> {
  createMcpOAuthProvider(callbackUrl: string): DurableObjectOAuthClientProvider {
    return new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      "World ID for ChatGPT",
      callbackUrl,
    );
  }

  async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({ successRedirect: "/partner-connected" });
    this.sql`
      CREATE TABLE IF NOT EXISTS partner_action_confirmations (
        token TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
  }

  async connectPartner(provider: PartnerId): Promise<PartnerConnectResult> {
    const config = PARTNERS[provider];
    const existing = this.getMcpServers().servers[provider];
    if (shouldRestartPartnerConnection(existing?.state)) {
      await this.removeMcpServer(provider);
    }
    const result = await this.addMcpServer(config.name, config.mcpUrl, {
      id: provider,
      callbackHost: this.env.PUBLIC_ORIGIN.replace(/\/+$/u, ""),
      // Agent's default uses the class name (`partner-hub-agent`), while
      // routeAgentRequest keys this Durable Object by its binding (`partner-hub`).
      callbackPath: partnerHubCallbackPath(this.name),
      transport: { type: "streamable-http" },
      retry: { maxAttempts: 2, baseDelayMs: 300 },
    });
    if (result.state === "authenticating") {
      return {
        provider,
        name: config.name,
        state: "authenticating",
        error: null,
        connectUrl: result.authUrl,
      };
    }
    return { provider, name: config.name, state: "ready", error: null };
  }

  getPartnerStatuses(): PartnerConnectionStatus[] {
    const servers = this.getMcpServers().servers;
    return PARTNER_IDS.map((provider) => {
      const server = servers[provider];
      return {
        provider,
        name: PARTNERS[provider].name,
        state: server?.state ?? "not_connected",
        error: server?.error ?? null,
      };
    });
  }

  async listPartnerTools(provider: PartnerId): Promise<string> {
    await this.mcp.waitForConnections({ timeout: 10_000 });
    const tools = this.mcp.listTools({ serverId: provider })
      .map((tool) => publicTool(tool, provider))
      .filter((tool): tool is PartnerToolSummary => tool !== null);
    return JSON.stringify(tools);
  }

  async callPartnerTool(
    provider: PartnerId,
    tool: string,
    args: Record<string, unknown>,
    expectedKind: "read" | "write",
  ): Promise<string> {
    const kind = partnerToolKind(provider, tool);
    if (kind !== expectedKind) throw new Error(`The ${tool} tool is not an allowed ${expectedKind} operation for ${provider}`);
    await this.mcp.waitForConnections({ timeout: 10_000 });
    const state = this.getMcpServers().servers[provider]?.state;
    if (state !== "ready") throw new Error(`${PARTNERS[provider].name} is not connected`);
    try {
      const result = await this.mcp.callTool({ serverId: provider, name: tool, arguments: args });
      if (isUnauthorizedPartnerError(result)) return this.restartUnauthorizedPartner(provider);
      return JSON.stringify(sanitizePartnerToolResult(result));
    } catch (error) {
      if (isUnauthorizedPartnerError(error)) return this.restartUnauthorizedPartner(provider);
      throw error;
    }
  }

  private async restartUnauthorizedPartner(provider: PartnerId): Promise<string> {
    const connection = this.mcp.mcpConnections[provider];
    const authProvider = connection?.options.transport.authProvider;
    if (connection && authProvider?.authUrl && authProvider.redirectUrl) {
      connection.connectionState = "authenticating";
      const manager = this.mcp as unknown as {
        persistAuthContinuation: (
          serverId: string,
          activeConnection: typeof connection,
        ) => { authUrl?: string } | undefined;
      };
      manager.persistAuthContinuation(provider, connection);
      return JSON.stringify({
        isError: true,
        content: [{
          type: "text",
          text: `${PARTNERS[provider].name} requires a fresh sign-in. No provider action was performed. Reconnect using this provider-hosted link: ${authProvider.authUrl}`,
        }],
        structuredContent: {
          status: "reauthorization_required",
          provider,
          name: PARTNERS[provider].name,
          connect_url: authProvider.authUrl,
        },
      });
    }

    await this.removeMcpServer(provider);
    const reconnection = await this.connectPartner(provider);
    const connectUrl = reconnection.connectUrl;
    return JSON.stringify({
      isError: true,
      content: [{
        type: "text",
        text: connectUrl
          ? `${reconnection.name} rejected the saved authorization. No provider action was performed. Reconnect using this provider-hosted sign-in link: ${connectUrl}`
          : `${reconnection.name} authorization was refreshed. No provider action was performed; retry only after confirming the connection is ready.`,
      }],
      structuredContent: {
        status: connectUrl ? "reauthorization_required" : "connection_refreshed",
        provider,
        name: reconnection.name,
        ...(connectUrl ? { connect_url: connectUrl } : {}),
      },
    });
  }

  preparePartnerAction(
    provider: PartnerId,
    tool: string,
    args: Record<string, unknown>,
  ): { confirmationToken: string; expiresAt: string } {
    if (partnerToolKind(provider, tool) !== "write") {
      throw new Error(`The ${tool} tool is not an approved write operation for ${provider}`);
    }
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + 10 * 60;
    const confirmationToken = crypto.randomUUID();
    this.sql`DELETE FROM partner_action_confirmations WHERE expires_at <= ${now} OR status <> 'pending'`;
    this.sql`
      INSERT INTO partner_action_confirmations
        (token, provider, tool, args_json, status, expires_at, created_at)
      VALUES
        (${confirmationToken}, ${provider}, ${tool}, ${JSON.stringify(args)}, 'pending', ${expiresAt}, ${now})
    `;
    return { confirmationToken, expiresAt: new Date(expiresAt * 1_000).toISOString() };
  }

  async executeConfirmedPartnerAction(
    provider: PartnerId,
    tool: string,
    confirmationToken: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const rows = this.sql<PendingPartnerActionRow>`
      UPDATE partner_action_confirmations
      SET status = 'used'
      WHERE token = ${confirmationToken}
        AND provider = ${provider}
        AND tool = ${tool}
        AND status = 'pending'
        AND expires_at > ${now}
      RETURNING provider, tool, args_json
    `;
    const row = rows[0];
    if (!row) throw new Error("This partner-action confirmation is invalid, expired, or already used");
    const args = JSON.parse(row.args_json) as Record<string, unknown>;
    return this.callPartnerTool(provider, tool, args, "write");
  }
}
