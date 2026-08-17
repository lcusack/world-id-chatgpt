import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWallAnswer,
  publicAnswer,
  WALL_ANSWER_MAX_LENGTH,
} from "../worker/wall-shared.ts";

test("normalizes a publishable answer without rewriting its meaning", () => {
  assert.equal(
    normalizeWallAnswer("  Humans should control irreversible AI actions.\r\n\r\nConsent matters.  "),
    "Humans should control irreversible AI actions.\n\nConsent matters.",
  );
});

test("rejects short, oversized, linked, contact, and control-character answers", () => {
  assert.throws(() => normalizeWallAnswer("Too short"), /at least 10/u);
  assert.throws(() => normalizeWallAnswer("a".repeat(WALL_ANSWER_MAX_LENGTH + 1)), /or fewer/u);
  assert.throws(() => normalizeWallAnswer("Read my answer at https://example.com today"), /Links/u);
  assert.throws(() => normalizeWallAnswer("Contact human@example.com for the full answer"), /Email/u);
  assert.throws(() => normalizeWallAnswer("A valid-looking answer\u0000with control data"), /control/u);
});

test("public answer projection never includes an internal subject", () => {
  const source = {
    id: "answer_1",
    body: "Verified humans should approve consequential AI actions.",
    created_at: 1_786_579_200,
    updated_at: 1_786_579_200,
    subject_id: "wid_secret_internal_subject",
  };
  const result = publicAnswer(source);
  assert.deepEqual(Object.keys(result), ["id", "body", "created_at", "updated_at"]);
  assert.equal(JSON.stringify(result).includes(source.subject_id), false);
});
