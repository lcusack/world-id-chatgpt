import { acceptedContent, inputRequired, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { getAgentByName } from "agents";
import { z } from "zod";
import { sha256 } from "./crypto";
import {
  PARTNER_IDS,
  PARTNERS,
  partnerToolKind,
  supportsFormElicitation,
  type PartnerId,
} from "./partner-registry";
import type { PartnerHubAgent } from "./partner-hub-agent";
import type { AuthProps, Env } from "./types";
import { integratedProviderForBenefit } from "./partner-catalog";
import {
  fetchOfficialWorldIdBenefits,
} from "./world-id-benefit-catalog";

const providerSchema = z.enum(PARTNER_IDS);
const connectionStateSchema = z.enum([
  "not_connected",
  "authenticating",
  "connecting",
  "connected",
  "discovering",
  "ready",
  "failed",
]);
const toolArgumentsSchema = z.record(z.string(), z.unknown()).default({});
const confirmationTokenSchema = z.string().uuid().optional();
const writeApprovalSchema = z.object({ confirm: z.literal(true) });
const partnerToolSummarySchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  kind: z.enum(["read", "write"]),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
});
const downstreamToolResultSchema = z.object({
  isError: z.literal(true).optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

function currentSubjectId(): string {
  const context = getMcpAuthContext();
  const props = context?.props as Partial<AuthProps> | undefined;
  if (!props?.subjectId || typeof props.subjectId !== "string") throw new Error("A connected World ID session is required");
  return props.subjectId;
}

async function currentHub(env: Env): Promise<DurableObjectStub<PartnerHubAgent>> {
  const instanceName = (await sha256(`world-id-partner-hub:v1:${currentSubjectId()}`)).slice(0, 43);
  return getAgentByName<Cloudflare.Env, PartnerHubAgent>(env.PARTNER_HUB, instanceName);
}

function parsePartnerTools(value: string) {
  return z.array(partnerToolSummarySchema).parse(JSON.parse(value) as unknown);
}

function parsePartnerToolResult(value: string) {
  return downstreamToolResultSchema.parse(JSON.parse(value) as unknown);
}

function createWorldIdHubMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "world-id-hub", version: "0.1.0" },
    {
      instructions: "This is the unified World ID hub. Show only benefits returned by the official World ID catalog. AgentMail and Maître are optional downstream connections: installing this hub does not authorize either provider. Call connect_world_id_partner only when the user asks to use that provider, then show its exact authorization URL. Use read_world_id_partner for allowed reads. Use act_world_id_partner only for an explicitly requested action and complete the tool's confirmation step before proceeding. If it returns confirmation_required, show the exact stored arguments and ask the user; only after explicit approval call it again with the same provider and tool plus confirmation_token. Never request, display, or forward OAuth tokens, World ID proofs, subjects, nullifiers, biometrics, or provider credentials.",
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "get_verified_human_status",
    {
      title: "Check verified human status",
      description: "Check the connected account's active proof of humanity. A connected account is not necessarily a verified human. Returns no identity identifiers or proof material.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        profile_status: z.enum(["verified", "unverified"]),
        verified_human: z.boolean(),
        verification_level: z.literal("orb").nullable(),
        verified_at: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const props = getMcpAuthContext()?.props as Partial<AuthProps> | undefined;
      if (!props?.subjectId) throw new Error("A connected World ID session is required");
      const status = {
        profile_status: "verified" as const,
        verified_human: true,
        verification_level: "orb" as const,
        verified_at: props.verifiedAt ?? null,
      };
      return {
        structuredContent: status,
        content: [{ type: "text", text: status.verified_human ? "The connected account has an active World ID proof of humanity." : "The connected account is not a verified human." }],
      };
    },
  );

  server.registerTool(
    "get_world_id_hub",
    {
      title: "Show official World ID benefits and connection status",
      description: "Load the live official World ID benefit catalog and show whether the built-in AgentMail and Maître integrations are ready or need a one-time provider connection.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        world_id_connected: z.literal(true),
        benefits: z.array(z.object({
          name: z.string(),
          description: z.string(),
          app_url: z.string().url(),
          integrated_provider: providerSchema.nullable(),
          connection_state: connectionStateSchema.nullable(),
        })),
        connections: z.array(z.object({
          provider: providerSchema,
          name: z.string(),
          state: connectionStateSchema,
          error: z.string().nullable(),
        })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const hub = await currentHub(env);
      const [benefits, connections] = await Promise.all([
        fetchOfficialWorldIdBenefits(),
        hub.getPartnerStatuses(),
      ]);
      const states = new Map(connections.map((connection) => [connection.provider, connection.state]));
      const structuredContent = {
        world_id_connected: true as const,
        benefits: benefits.map((benefit) => {
          const provider = integratedProviderForBenefit(benefit);
          return {
            name: benefit.name,
            description: benefit.description,
            app_url: benefit.appUrl,
            integrated_provider: provider,
            connection_state: provider ? states.get(provider) ?? "not_connected" : null,
          };
        }),
        connections,
      };
      return {
        structuredContent,
        content: [{
          type: "text",
          text: `Found ${benefits.length} benefit${benefits.length === 1 ? "" : "s"} in the official World ID catalog. AgentMail and Maître can be connected from this hub when first used.`,
        }],
      };
    },
  );

  server.registerTool(
    "connect_world_id_partner",
    {
      title: "Connect a World ID partner",
      description: "Begin the existing OAuth connection for AgentMail or Maître. Call only when the user asks to use that provider. This returns a provider-hosted authorization URL and does not share World ID credentials.",
      inputSchema: z.object({ provider: providerSchema }),
      outputSchema: z.object({
        provider: providerSchema,
        name: z.string(),
        state: connectionStateSchema,
        error: z.string().nullable(),
        connect_url: z.string().url().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ provider }) => {
      const result = await (await currentHub(env)).connectPartner(provider);
      const structuredContent = {
        provider: result.provider,
        name: result.name,
        state: result.state,
        error: result.error,
        ...(result.connectUrl ? { connect_url: result.connectUrl } : {}),
      };
      return {
        structuredContent,
        content: [{
          type: "text",
          text: result.connectUrl
            ? `Authorize ${result.name} using this provider-hosted link: ${result.connectUrl}`
            : `${result.name} is connected and ready.`,
        }],
      };
    },
  );

  server.registerTool(
    "get_world_id_partner_tools",
    {
      title: "Inspect connected partner capabilities",
      description: "List the approved existing MCP tools and their current input schemas for one connected partner. Use this before the first delegated call so arguments match the provider's live integration.",
      inputSchema: z.object({ provider: providerSchema }),
      outputSchema: z.object({
        provider: providerSchema,
        tools: z.array(partnerToolSummarySchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ provider }) => {
      const tools = parsePartnerTools(await (await currentHub(env)).listPartnerTools(provider));
      return {
        structuredContent: { provider, tools },
        content: [{ type: "text", text: `${PARTNERS[provider].name} exposes ${tools.length} approved ${tools.length === 1 ? "capability" : "capabilities"}.` }],
      };
    },
  );

  server.registerTool(
    "read_world_id_partner",
    {
      title: "Read from a connected World ID partner",
      description: "Call one approved read-only tool on a connected AgentMail or Maître MCP server. First inspect the provider's live input schema with get_world_id_partner_tools.",
      inputSchema: z.object({ provider: providerSchema, tool: z.string().min(1).max(100), arguments: toolArgumentsSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args }) => {
      if (partnerToolKind(provider, tool) !== "read") {
        throw new Error(`The ${tool} tool is not an approved read operation for ${provider}`);
      }
      return parsePartnerToolResult(await (await currentHub(env)).callPartnerTool(provider, tool, args, "read"));
    },
  );

  server.registerTool(
    "act_world_id_partner",
    {
      title: "Take an action with a connected World ID partner",
      description: "Call one approved write tool on AgentMail or Maître only after the user explicitly requests the exact action. The user must approve the generated confirmation before the provider call is made.",
      inputSchema: z.object({
        provider: providerSchema,
        tool: z.string().min(1).max(100),
        arguments: toolArgumentsSchema,
        confirmation_token: confirmationTokenSchema.describe("On clients without form elicitation, supply only the short-lived token returned by the previous call after the user explicitly approves the unchanged action."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args, confirmation_token: confirmationToken }, context) => {
      if (partnerToolKind(provider, tool) !== "write") {
        throw new Error(`The ${tool} tool is not an approved write operation for ${provider}`);
      }
      const hub = await currentHub(env);
      if (confirmationToken) {
        return parsePartnerToolResult(await hub.executeConfirmedPartnerAction(provider, tool, confirmationToken));
      }
      const approval = acceptedContent(context.mcpReq.inputResponses, "partner_action", writeApprovalSchema);
      if (!approval && supportsFormElicitation(server.server.getClientCapabilities())) {
        const argumentNames = Object.keys(args).slice(0, 12).join(", ") || "none";
        return inputRequired({
          inputRequests: {
            partner_action: inputRequired.elicit({
              message: `Approve ${PARTNERS[provider].name} action “${tool}”. Supplied fields: ${argumentNames}. The provider—not World ID—will perform this action using your separate ${PARTNERS[provider].name} authorization.`,
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean", title: "Approve this provider action" } },
                required: ["confirm"],
                additionalProperties: false,
              },
            }),
          },
        });
      }
      if (!approval) {
        const pending = await hub.preparePartnerAction(provider, tool, args);
        return {
          structuredContent: {
            status: "confirmation_required",
            provider,
            tool,
            confirmation_token: pending.confirmationToken,
            expires_at: pending.expiresAt,
            arguments: args,
          },
          content: [{
            type: "text",
            text: `Confirmation required before ${PARTNERS[provider].name} performs “${tool}”. Show the user the exact action arguments and ask for explicit approval. Only after approval, call act_world_id_partner again with the same provider and tool plus confirmation_token “${pending.confirmationToken}”. The stored arguments cannot be changed, and the token expires at ${pending.expiresAt}.`,
          }],
        };
      }
      return parsePartnerToolResult(await hub.callPartnerTool(provider, tool, args, "write"));
    },
  );

  return server;
}

export const hubMcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rateKey = await sha256(request.headers.get("authorization") ?? "authenticated");
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: `hub:${rateKey}` });
    if (!success) return new Response("Too many MCP requests", { status: 429, headers: { "retry-after": "60" } });
    const handler = createMcpHandler(() => createWorldIdHubMcpServer(env), { route: "/mcp/hub", corsOptions: false });
    return handler(request, env, ctx);
  },
};
