import assert from "node:assert/strict";
import test from "node:test";
import { VerificationStore } from "../src/verification-store.js";

test("verification attempts move from pending to expired", () => {
  let now = Date.parse("2026-08-12T12:00:00.000Z");
  const store = new VerificationStore({ ttlMs: 1_000, now: () => now });
  const attempt = store.create();

  assert.equal(store.get(attempt.id).status, "pending");
  now += 1_000;
  assert.equal(store.get(attempt.id).status, "expired");
});

test("verified attempts expose only stored claims", () => {
  const store = new VerificationStore();
  const attempt = store.create();
  const claims = {
    verified_human: true,
    verification_level: "orb",
    verified_at: "2026-08-12T12:00:00.000Z",
  };

  const verified = store.markVerified(attempt.id, claims);
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.claims, claims);
});
