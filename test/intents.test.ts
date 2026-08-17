import assert from "node:assert/strict";
import test from "node:test";
import { sha256, signReceipt, verifyReceiptSignature } from "../worker/crypto.ts";
import { canonicalIntentJson, canonicalizeHumanIntent } from "../worker/intents.ts";
import { PublicError } from "../worker/world-id.ts";

const hmacKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

test("canonicalizes an approved intent without silently rewriting its meaning", async () => {
  const intent = canonicalizeHumanIntent({
    title: "  Approve research run  ",
    instruction: "Search the public web for the named companies.\r\nDo not contact anyone.  ",
    audience: "  Research agent ",
    constraints: [" Public sources only ", "Do not send messages"],
  });
  assert.deepEqual(intent, {
    title: "Approve research run",
    instruction: "Search the public web for the named companies.\nDo not contact anyone.",
    audience: "Research agent",
    constraints: ["Public sources only", "Do not send messages"],
  });
  const canonical = canonicalIntentJson(intent);
  assert.equal(canonical, JSON.stringify(intent));
  assert.equal(await sha256(canonical), await sha256(canonicalIntentJson(intent)));
});

test("rejects empty, oversized, and ambiguous approval inputs", () => {
  assert.throws(
    () => canonicalizeHumanIntent({ title: "No", instruction: "This instruction is long enough" }),
    (error: unknown) => error instanceof PublicError && error.message.includes("title"),
  );
  assert.throws(
    () => canonicalizeHumanIntent({ title: "Valid title", instruction: "Too short" }),
    (error: unknown) => error instanceof PublicError && error.message.includes("instruction"),
  );
  assert.throws(
    () => canonicalizeHumanIntent({ title: "Valid title", instruction: "This instruction is long enough", constraints: ["   "] }),
    (error: unknown) => error instanceof PublicError && error.message.includes("constraints"),
  );
});

test("receipt signatures are deterministic and fail after any intent change", async () => {
  const payload = JSON.stringify({
    schema: "world-id-human-approval-receipt/v1",
    receipt_id: "hir_example",
    intent_hash: "sha256-example",
  });
  const signature = await signReceipt(payload, hmacKey);
  assert.equal(await signReceipt(payload, hmacKey), signature);
  assert.equal(await verifyReceiptSignature(payload, signature, hmacKey), true);
  assert.equal(await verifyReceiptSignature(payload.replace("example", "tampered"), signature, hmacKey), false);
  assert.equal(await verifyReceiptSignature(payload, `${signature}x`, hmacKey), false);
});
