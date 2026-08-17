import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorldAgentClaimFormToken,
  verifyWorldAgentClaimFormToken,
} from "../worker/request-security.ts";

const claimToken = "encrypted-browser-bound-claim-capability";

test("accepts only the form token bound to the encrypted claim cookie", async () => {
  const formToken = await createWorldAgentClaimFormToken(claimToken);
  assert.equal(await verifyWorldAgentClaimFormToken(claimToken, formToken), true);
  assert.equal(await verifyWorldAgentClaimFormToken(`${claimToken}-other`, formToken), false);
});

test("rejects absent and malformed Founding Human form tokens", async () => {
  assert.equal(await verifyWorldAgentClaimFormToken(claimToken, null), false);
  assert.equal(await verifyWorldAgentClaimFormToken(claimToken, "not-a-token"), false);
});
