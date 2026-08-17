import assert from "node:assert/strict";
import test from "node:test";
import { hashSignal } from "@worldcoin/idkit-core";
import {
  createWorldIdService,
  validateProofBinding,
  WorldIdError,
} from "../src/world-id.js";

const context = {
  verificationId: "a-secure-random-verification-id",
  action: "link-chatgpt",
  environment: "staging",
};

const proof = {
  protocol_version: "4.0",
  action: context.action,
  environment: context.environment,
  responses: [
    {
      identifier: "proof_of_human",
      signal_hash: hashSignal(context.verificationId),
      proof: ["0x1"],
    },
  ],
};

test("accepts a Proof of Human bound to the verification link", () => {
  const response = validateProofBinding(proof, context);
  assert.equal(response.identifier, "proof_of_human");
});

test("rejects a proof copied from another verification link", () => {
  assert.throws(
    () =>
      validateProofBinding(proof, {
        ...context,
        verificationId: "a-different-verification-id",
      }),
    WorldIdError,
  );
});

test("accepts only a successful Developer Portal result for the bound credential", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        success: true,
        results: [{ identifier: "proof_of_human", success: true }],
        created_at: "2026-08-12T12:00:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const service = createWorldIdService(
    {
      rpId: "rp_test",
      signingKey: "unused",
      action: context.action,
      environment: context.environment,
    },
    fetchImpl,
  );

  const claims = await service.verifyProof(
    JSON.stringify(proof),
    proof,
    context.verificationId,
  );
  assert.equal(claims.verified_human, true);
  assert.equal(claims.verification_level, "orb");
  assert.equal(claims.verified_at, "2026-08-12T12:00:00.000Z");
});
