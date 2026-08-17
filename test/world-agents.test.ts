import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorldAgentClaimLink,
  displayWorldAgentNumber,
  renderWorldAgentClaimPage,
  renderWorldAgentNetworkPage,
  renderWorldAgentProfilePage,
  resolveWorldAgentClaimToken,
  worldAgentCohort,
  type PublicWorldAgentProfile,
  type WorldAgentNetwork,
} from "../worker/world-agents.ts";

const claimCapabilityEnv = {
  DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  PUBLIC_ORIGIN: "https://world-id-chatgpt.foundry-world.workers.dev",
};

const network: WorldAgentNetwork = {
  name: "World ID",
  claimed_humans: 3,
  genesis_claimed: 3,
  genesis_limit: 100,
  genesis_complete: false,
  next_capability: "A new verified-human capability is coming next.",
  network_url: "https://world-id-chatgpt.foundry-world.workers.dev/founding-humans",
};

const profile: PublicWorldAgentProfile = {
  agent_number: 3,
  display_number: "#0003",
  cohort: "Genesis 100",
  registered_at: "2026-08-12T12:00:00.000Z",
  claimed_at: "2026-08-16T12:00:00.000Z",
  verification: "Orb · World ID 4.0",
  share_url: "https://world-id-chatgpt.foundry-world.workers.dev/founding-human/abcdefghijklmnopqrstuvwx",
  invite_url: "https://world-id-chatgpt.foundry-world.workers.dev/founding-human/abcdefghijklmnopqrstuvwx",
};

test("formats durable Founding Human numbers and cohorts", () => {
  assert.equal(displayWorldAgentNumber(3), "#0003");
  assert.equal(displayWorldAgentNumber(12_345), "#12345");
  assert.equal(worldAgentCohort(100), "Genesis 100");
  assert.equal(worldAgentCohort(101), "Founding 1,000");
  assert.equal(worldAgentCohort(1_001), "Early 10,000");
  assert.equal(worldAgentCohort(10_001), "Founding Human");
});

test("renders a shareable Genesis card without private World ID material", () => {
  const html = renderWorldAgentProfilePage(profile, network);
  assert.match(html, /Founding Human #0003/u);
  assert.match(html, /Genesis 100/u);
  assert.match(html, /Claim my place as a Founding Human/u);
  assert.equal(html.includes("subject_id"), false);
  assert.equal(html.includes("session_id"), false);
  assert.equal(html.includes("nullifier"), false);
  assert.equal(html.includes("World Agent"), false);
  assert.equal(html.includes('href="/submit"'), false);
});

test("escapes every public registry value before rendering", () => {
  const html = renderWorldAgentNetworkPage({
    ...network,
    next_capability: "<script>alert(1)</script>",
    founding_agents: [profile],
  });
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /#0003/u);
  assert.equal(html.includes("World Agent"), false);
  assert.equal(html.includes('href="/submit"'), false);
});

test("creates a short-lived encrypted Founding Human claim capability", async () => {
  const subjectId = `wid_${"A".repeat(43)}`;
  const claim = await createWorldAgentClaimLink(claimCapabilityEnv, subjectId);
  assert.match(claim.claimUrl, /^https:\/\/world-id-chatgpt\.foundry-world\.workers\.dev\/claim-founding-human\//u);
  const token = decodeURIComponent(new URL(claim.claimUrl).pathname.split("/").at(-1)!);
  const capability = await resolveWorldAgentClaimToken(claimCapabilityEnv, token);
  assert.equal(capability.subjectId, subjectId);
  assert.equal(capability.purpose, "world-agent-claim");
  await assert.rejects(
    resolveWorldAgentClaimToken(claimCapabilityEnv, `${token.slice(0, -1)}x`),
    /invalid or expired/u,
  );
});

test("renders an explicit browser confirmation before publishing a Founding Human card", () => {
  const html = renderWorldAgentClaimPage({
    claimed: false,
    reserved_number: "#0003",
    network,
  }, "A".repeat(43));
  assert.match(html, /#0003 is reserved for you/u);
  assert.match(html, /method="post" action="\/claim-founding-human"/u);
  assert.match(html, /name="form_token" value="A{43}"/u);
  assert.match(html, /Claim and publish my card/u);
  assert.equal(html.includes("World Agent"), false);
  assert.equal(html.includes("subject_id"), false);
  assert.equal(html.includes("session_id"), false);
});
