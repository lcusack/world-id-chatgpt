import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const statusOutputSchema = {
  verification_id: z.string(),
  status: z.enum(["pending", "verified", "expired"]),
  expires_at: z.string(),
  verified_human: z.boolean().optional(),
  verification_level: z.literal("orb").optional(),
  verified_at: z.string().optional(),
};

const toolResult = (structuredContent, text) => ({
  structuredContent,
  content: [{ type: "text", text }],
});

export function serializeAttempt(attempt, fallbackId) {
  if (!attempt) {
    return {
      verification_id: fallbackId,
      status: "expired",
      expires_at: new Date(0).toISOString(),
    };
  }

  const result = {
    verification_id: attempt.id,
    status: attempt.status,
    expires_at: attempt.expiresAt,
  };
  if (attempt.status === "verified" && attempt.claims) {
    result.verified_human = attempt.claims.verified_human;
    result.verification_level = attempt.claims.verification_level;
    result.verified_at = attempt.claims.verified_at;
  }
  return result;
}

export function createMcpServer({ store, publicBaseUrl }) {
  const server = new McpServer(
    {
      name: "world-id-verification",
      version: "0.1.0",
    },
    {
      instructions:
        "Use start_world_id_verification when the user wants to prove they are a verified human. Give them the returned URL. After they verify, call get_verification_status with the same verification_id. Never claim verification unless status is verified and verified_human is true.",
    },
  );

  server.registerTool(
    "start_world_id_verification",
    {
      title: "Start World ID verification",
      description:
        "Create a short-lived World ID Proof of Human link. Use when a user asks to verify or prove they are a verified human.",
      inputSchema: {},
      outputSchema: {
        ...statusOutputSchema,
        verification_url: z.string().url(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const attempt = store.create();
      const verificationUrl = new URL(
        `/verify/${encodeURIComponent(attempt.id)}`,
        publicBaseUrl,
      ).toString();
      const structuredContent = {
        ...serializeAttempt(attempt),
        verification_url: verificationUrl,
      };
      return toolResult(
        structuredContent,
        `Open this short-lived link to verify with World ID: ${verificationUrl}`,
      );
    },
  );

  server.registerTool(
    "get_verification_status",
    {
      title: "Get World ID verification status",
      description:
        "Check a previously created World ID verification link. A user is verified only when status is verified and verified_human is true.",
      inputSchema: {
        verification_id: z.string().min(16).max(128),
      },
      outputSchema: statusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ verification_id: verificationId }) => {
      const structuredContent = serializeAttempt(
        store.get(verificationId),
        verificationId,
      );
      const text =
        structuredContent.status === "verified"
          ? "World ID verification succeeded. This user has a valid Orb-backed Proof of Human."
          : `World ID verification is ${structuredContent.status}.`;
      return toolResult(structuredContent, text);
    },
  );

  return server;
}
