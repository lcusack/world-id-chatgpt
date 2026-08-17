import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/http.js";
import { VerificationStore } from "../src/verification-store.js";

test("MCP tools create a link and report its verified status", async (t) => {
  const store = new VerificationStore();
  const config = {
    publicBaseUrl: "https://verify.example",
    world: {
      appId: "app_test",
      rpId: "rp_test",
      action: "link-chatgpt",
      environment: "staging",
    },
  };
  const worldId = {
    createRpContext: () => ({
      rp_id: "rp_test",
      sig: "0xsig",
      nonce: "0xnonce",
      created_at: 1,
      expires_at: 2,
    }),
    verifyProof: async () => ({
      verified_human: true,
      verification_level: "orb",
      verified_at: "2026-08-12T12:00:00.000Z",
    }),
  };

  const httpServer = createHttpServer({ config, store, worldId });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  const address = httpServer.address();
  const mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  const client = new Client({ name: "prototype-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["get_verification_status", "start_world_id_verification"],
  );

  const started = await client.callTool({
    name: "start_world_id_verification",
    arguments: {},
  });
  assert.equal(started.structuredContent.status, "pending");
  assert.match(
    started.structuredContent.verification_url,
    /^https:\/\/verify\.example\/verify\//,
  );

  const verificationId = started.structuredContent.verification_id;
  const verificationPage = await fetch(
    `http://127.0.0.1:${address.port}/verify/${verificationId}`,
  );
  assert.equal(verificationPage.status, 200);
  assert.match(
    verificationPage.headers.get("content-security-policy"),
    /script-src 'self' 'wasm-unsafe-eval'/,
  );

  const pending = await client.callTool({
    name: "get_verification_status",
    arguments: { verification_id: verificationId },
  });
  assert.equal(pending.structuredContent.status, "pending");

  const proofResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/verification/${verificationId}/proof`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fake: "proof" }),
    },
  );
  assert.equal(proofResponse.status, 200);

  const verified = await client.callTool({
    name: "get_verification_status",
    arguments: { verification_id: verificationId },
  });
  assert.deepEqual(verified.structuredContent, {
    verification_id: verificationId,
    status: "verified",
    expires_at: started.structuredContent.expires_at,
    verified_human: true,
    verification_level: "orb",
    verified_at: "2026-08-12T12:00:00.000Z",
  });
});
