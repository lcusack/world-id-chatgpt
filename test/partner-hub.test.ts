import assert from "node:assert/strict";
import test from "node:test";
import { integratedProviderForBenefit } from "../worker/partner-catalog.ts";
import pluginMcp from "../plugins/world-id/.mcp.json" with { type: "json" };
import {
  PARTNERS,
  isUnauthorizedPartnerError,
  partnerHubCallbackPath,
  partnerToolKind,
  sanitizePartnerToolResult,
  shouldRestartPartnerConnection,
  supportsFormElicitation,
} from "../worker/partner-registry.ts";

test("uses the providers' existing production MCP endpoints", () => {
  assert.equal(PARTNERS.agentmail.mcpUrl, "https://mcp.agentmail.to/mcp");
  assert.equal(PARTNERS.maitre.mcpUrl, "https://www.maitre.fun/mcp");
});

test("routes partner OAuth callbacks through the Durable Object binding name", () => {
  assert.equal(
    partnerHubCallbackPath("user-instance"),
    "agents/partner-hub/user-instance/callback",
  );
  assert.equal(
    partnerHubCallbackPath("name/with spaces"),
    "agents/partner-hub/name%2Fwith%20spaces/callback",
  );
});

test("restarts stale or failed partner authorization attempts on an explicit retry", () => {
  assert.equal(shouldRestartPartnerConnection("authenticating"), true);
  assert.equal(shouldRestartPartnerConnection("failed"), true);
  assert.equal(shouldRestartPartnerConnection("ready"), false);
  assert.equal(shouldRestartPartnerConnection(undefined), false);
});

test("uses form elicitation only when the negotiated client capability supports it", () => {
  assert.equal(supportsFormElicitation({ elicitation: { form: {} } }), true);
  assert.equal(supportsFormElicitation({ elicitation: {} }), true);
  assert.equal(supportsFormElicitation({ elicitation: { url: {} } }), false);
  assert.equal(supportsFormElicitation({}), false);
  assert.equal(supportsFormElicitation(undefined), false);
});

test("recognizes downstream authentication failures that require a fresh provider connection", () => {
  assert.equal(isUnauthorizedPartnerError(new Error("Unauthorized")), true);
  assert.equal(isUnauthorizedPartnerError({ isError: true, content: [{ type: "text", text: "HTTP 401" }] }), true);
  assert.equal(isUnauthorizedPartnerError({ error: { message: "Unauthenticated" } }), true);
  assert.equal(isUnauthorizedPartnerError({ isError: true, content: [{ type: "text", text: "Seat unavailable" }] }), false);
});

test("matches official catalog listings to built-in integrations", () => {
  assert.equal(integratedProviderForBenefit({
    name: "Human verified email",
    description: "Email for agents",
    appUrl: "https://console.agentmail.to/account/connected-accounts",
  }), "agentmail");
  assert.equal(integratedProviderForBenefit({
    name: "Maître",
    description: "Restaurant reservations",
    appUrl: "https://www.maitre.fun/",
  }), "maitre");
  assert.equal(integratedProviderForBenefit({
    name: "Another benefit",
    description: "Provider-managed",
    appUrl: "https://example.com/claim",
  }), null);
});

test("exposes only explicitly approved downstream tools", () => {
  assert.equal(partnerToolKind("agentmail", "list_inboxes"), "read");
  assert.equal(partnerToolKind("agentmail", "send_message"), "write");
  assert.equal(partnerToolKind("maitre", "list_seats"), "read");
  assert.equal(partnerToolKind("maitre", "claim_seat"), "write");
  assert.equal(partnerToolKind("maitre", "logout"), null);
  assert.equal(partnerToolKind("agentmail", "unknown_admin_tool"), null);
});

test("removes downstream metadata and non-text content before returning results", () => {
  const result = sanitizePartnerToolResult({
    content: [
      { type: "text", text: "ready" },
      { type: "image", data: "opaque", mimeType: "image/png" },
    ],
    structuredContent: { status: "ready" },
    _meta: { access_token: "must-not-cross-the-hub" },
  });

  assert.deepEqual(result, {
    content: [{ type: "text", text: "ready" }],
    structuredContent: { status: "ready" },
  });
  assert.equal("_meta" in result, false);
});

test("the plugin installs only the unified hub MCP", () => {
  assert.deepEqual(Object.keys(pluginMcp.mcpServers), ["world-id-hub"]);
  assert.equal(
    pluginMcp.mcpServers["world-id-hub"].url,
    "https://world-id-chatgpt.foundry-world.workers.dev/mcp/hub",
  );
});
