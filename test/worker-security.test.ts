import assert from "node:assert/strict";
import test from "node:test";
import { hmacSubject, openJson, sealJson } from "../worker/crypto.ts";
import { PublicError, validateSessionProof } from "../worker/world-id.ts";

const nonce = `0x${"12".repeat(32)}`;
const sessionId = `session_${"ab".repeat(64)}`;

function validProof() {
  return {
    protocol_version: "4.0",
    nonce,
    session_id: sessionId,
    environment: "production",
    user_presence_completed: true,
    responses: [{
      identifier: "proof_of_human",
      issuer_schema_id: 1,
      proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
      session_nullifier: ["0xaa", "0xbb"],
    }],
  };
}

test("accepts only a nonce-bound World ID 4.0 session proof", () => {
  const result = validateSessionProof(validProof(), nonce, "production");
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.replayValue, "4:0xaa|4:0xbb");
});

test("forwards evolving proof encodings to World's verifier", () => {
  const proof = validProof();
  proof.responses[0].proof = ["opaque-compressed-proof"];
  proof.responses[0].session_nullifier = ["opaque-session-nullifier"];
  const result = validateSessionProof(proof, nonce, "production");
  assert.equal(result.replayValue, "24:opaque-session-nullifier");
});

test("rejects uniqueness proofs, copied proofs, and absent presence checks", () => {
  assert.throws(
    () => validateSessionProof({ ...validProof(), action: "register" }, nonce, "production"),
    (error: unknown) => error instanceof PublicError && error.message.includes("uniqueness"),
  );
  assert.throws(
    () => validateSessionProof(validProof(), `0x${"34".repeat(32)}`, "production"),
    (error: unknown) => error instanceof PublicError && error.message.includes("bound"),
  );
  assert.throws(
    () => validateSessionProof({ ...validProof(), user_presence_completed: false }, nonce, "production"),
    (error: unknown) => error instanceof PublicError && error.message.includes("presence"),
  );
});

test("encrypts stored session data and derives a stable opaque subject", async () => {
  const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const hmacKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
  const sealed = await sealJson({ sessionId }, encryptionKey);
  assert.equal(sealed.ciphertext.includes(sessionId), false);
  assert.deepEqual(await openJson(sealed, encryptionKey), { sessionId });
  const first = await hmacSubject(sessionId, hmacKey);
  const second = await hmacSubject(sessionId, hmacKey);
  assert.equal(first, second);
  assert.match(first, /^wid_[A-Za-z0-9_-]+$/u);
  assert.equal(first.includes(sessionId), false);
});
