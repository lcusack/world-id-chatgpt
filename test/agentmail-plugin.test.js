import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("surfaces only production IdP-connected MCP services", async () => {
  const config = JSON.parse(await readFile(new URL("plugins/world-id/.mcp.json", root), "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["world-id-hub"]);
  assert.deepEqual(config.mcpServers["world-id-hub"], {
    type: "http",
    url: "https://world-id-chatgpt.foundry-world.workers.dev/mcp/hub",
  });
  assert.equal(config.mcpServers.agentmail, undefined);
  assert.equal(config.mcpServers.maitre, undefined);
});

test("coordinates AgentMail sends without overstating World ID assurance", async () => {
  const skill = await readFile(new URL("plugins/world-id/skills/agentmail-verified-email/SKILL.md", root), "utf8");
  assert.match(skill, /explicitly approved the final recipients, subject, and body/u);
  assert.match(skill, /does not prove that a human reviewed the exact email/u);
  assert.doesNotMatch(skill, /create_humanmark_inbox|Human Verified flow/u);
  assert.match(skill, /Do not ask the user to install AgentMail separately or provide an API key/u);
});

test("excludes experimental Worker skills and app surfaces", async () => {
  const manifest = JSON.parse(await readFile(new URL("plugins/world-id/.codex-plugin/plugin.json", root), "utf8"));
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /founding|humanmark|human-required|x402|foundry-world/u);
  await assert.rejects(readFile(new URL("plugins/world-id/.app.json", root), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(new URL("plugins/world-id/skills/humanmark-agent-email/SKILL.md", root), "utf8"), /ENOENT/u);
  await assert.rejects(readFile(new URL("plugins/world-id/skills/discover-unique-human-deals/SKILL.md", root), "utf8"), /ENOENT/u);
});

test("bundled skills depend only on the unified World ID hub", async () => {
  for (const skill of ["world-id-account", "world-id-benefits", "agentmail-verified-email", "maitre-booking"]) {
    const config = await readFile(new URL(`plugins/world-id/skills/${skill}/agents/openai.yaml`, root), "utf8");
    assert.match(config, /value: "world-id-hub"/u);
    assert.match(config, /\/mcp\/hub/u);
    assert.doesNotMatch(config, /humanmark|mcp\.agentmail|maitre\.fun\/mcp|auth\.world\.org\/mcp/u);
  }
  await assert.rejects(readFile(new URL("plugins/world-id/skills/world-id-developer/SKILL.md", root), "utf8"), /ENOENT/u);
});

test("bundles Maître as a World ID-connected reservation service", async () => {
  const skill = await readFile(new URL("plugins/world-id/skills/maitre-booking/SKILL.md", root), "utf8");
  const config = await readFile(new URL("plugins/world-id/skills/maitre-booking/agents/openai.yaml", root), "utf8");
  assert.match(skill, /call `get_world_id_hub`/u);
  assert.match(skill, /Delegate `wait_for_verification` through `read_world_id_partner`/u);
  assert.match(skill, /`pending` means restaurant confirmation is outstanding/u);
  assert.match(config, /value: "world-id-hub"/u);
  assert.match(config, /\/mcp\/hub/u);
  assert.doesNotMatch(config, /maitre\.fun\/mcp|auth\.world\.org\/mcp/u);
});
