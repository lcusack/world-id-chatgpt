import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  approveHumanGrant,
  createHumanGrant,
  createHumanGrantFormToken,
  exchangeHumanGrant,
  getHumanGrantByToken,
  renderHumanGrantConsentPage,
  verifyHumanGrantFormToken,
} from "../worker/human-grants.ts";
import { partnerSubject } from "../worker/crypto.ts";
import type { Env, HumanGrantRow, SessionRow } from "../worker/types.ts";

type Redemption = { partner_id: string; action_id: string; subject_id: string; grant_id: string; redeemed_at: number };

class MemoryHumanGrantDatabase {
  readonly grants = new Map<string, HumanGrantRow>();
  readonly redemptions: Redemption[] = [];
  readonly session: SessionRow;

  constructor(session: SessionRow) {
    this.session = session;
  }

  prepare(sql: string) {
    const database = this;
    let values: unknown[] = [];
    return {
      bind(...parameters: unknown[]) {
        values = parameters;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM human_grant_redemptions")) {
          const [partnerId, actionId, subjectId] = values as string[];
          return (database.redemptions.find((item) =>
            item.partner_id === partnerId && item.action_id === actionId && item.subject_id === subjectId,
          ) ?? null) as T | null;
        }
        if (sql.includes("FROM world_sessions")) {
          return (values[0] === database.session.subject_id ? database.session : null) as T | null;
        }
        if (sql.includes("WHERE subject_id = ? AND partner_id = ? AND action_id = ?")) {
          const [subjectId, partnerId, actionId, now] = values as [string, string, string, number];
          return ([...database.grants.values()].find((row) =>
            row.subject_id === subjectId
            && row.partner_id === partnerId
            && row.action_id === actionId
            && row.status === "pending"
            && row.consent_expires_at > now,
          ) ?? null) as T | null;
        }
        if (sql.includes("WHERE consent_token_hash = ?")) {
          return ([...database.grants.values()].find((row) => row.consent_token_hash === values[0]) ?? null) as T | null;
        }
        if (sql.includes("WHERE code_hash = ? AND partner_id = ?")) {
          return ([...database.grants.values()].find((row) =>
            row.code_hash === values[0] && row.partner_id === values[1],
          ) ?? null) as T | null;
        }
        if (sql.includes("WHERE id = ?")) return (database.grants.get(String(values[0])) ?? null) as T | null;
        throw new Error(`Unsupported first query: ${sql}`);
      },
      async run() {
        if (sql.includes("INSERT INTO human_grants")) {
          const [
            id, consentTokenHash, consentTokenCiphertext, consentTokenIv, subjectId,
            sessionRef, partnerId, actionId, pairwiseSubject, createdAt, consentExpiresAt,
          ] = values as [string, string, string, string, string, string, string, string, string, number, number];
          database.grants.set(id, {
            id,
            consent_token_hash: consentTokenHash,
            consent_token_ciphertext: consentTokenCiphertext,
            consent_token_iv: consentTokenIv,
            subject_id: subjectId,
            session_ref: sessionRef,
            partner_id: partnerId,
            action_id: actionId,
            partner_subject: pairwiseSubject,
            status: "pending",
            created_at: createdAt,
            consent_expires_at: consentExpiresAt,
            approved_at: null,
            code_hash: null,
            code_expires_at: null,
            redeemed_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'approved'")) {
          const [approvedAt, codeHash, codeExpiresAt, id, now] = values as [number, string, number, string, number];
          const row = database.grants.get(id);
          if (!row || row.status !== "pending" || row.consent_expires_at <= now) return { meta: { changes: 0 } };
          database.grants.set(id, { ...row, status: "approved", approved_at: approvedAt, code_hash: codeHash, code_expires_at: codeExpiresAt });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO human_grant_redemptions")) {
          const [partnerId, actionId, subjectId, grantId, redeemedAt] = values as [string, string, string, string, number];
          if (database.redemptions.some((item) => item.partner_id === partnerId && item.action_id === actionId && item.subject_id === subjectId)) {
            throw new Error("UNIQUE constraint failed: human_grant_redemptions");
          }
          database.redemptions.push({ partner_id: partnerId, action_id: actionId, subject_id: subjectId, grant_id: grantId, redeemed_at: redeemedAt });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'redeemed'")) {
          const [redeemedAt, id, codeHash, now] = values as [number, string, string, number];
          const row = database.grants.get(id);
          if (!row || row.status !== "approved" || row.code_hash !== codeHash || !row.code_expires_at || row.code_expires_at <= now) {
            return { meta: { changes: 0 } };
          }
          database.grants.set(id, { ...row, status: "redeemed", redeemed_at: redeemedAt });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM human_grants")) return { meta: { changes: 0 } };
        throw new Error(`Unsupported run query: ${sql}`);
      },
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function testEnvironment() {
  const now = Math.floor(Date.now() / 1_000);
  const session: SessionRow = {
    session_ref: "session-ref-123",
    subject_id: `wid_${"s".repeat(43)}`,
    session_id_ciphertext: "ciphertext",
    session_id_iv: "iv",
    created_at: now - 60,
    last_verified_at: now - 60,
  };
  const database = new MemoryHumanGrantDatabase(session);
  const env = {
    DB: database,
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 0).toString("base64url"),
    SUBJECT_HMAC_KEY: Buffer.alloc(32, 1).toString("base64url"),
    HUMAN_GATEWAY_DEMO_SECRET: Buffer.alloc(32, 2).toString("base64url"),
    PUBLIC_ORIGIN: "https://world-id-chatgpt.foundry-world.workers.dev",
  } as unknown as Env;
  return { env, database, session };
}

test("issues an audience-bound one-time human grant without exposing World identifiers", async () => {
  const { env, database, session } = testEnvironment();
  const created = await createHumanGrant(env, session.subject_id, "gateway-demo", "activate-demo-trial");
  assert.equal(created.status, "pending");
  const token = new URL(created.consent_url!).pathname.split("/").at(-1)!;
  const row = await getHumanGrantByToken(env, token);
  assert.ok(row);

  const formToken = await createHumanGrantFormToken(token);
  assert.equal(await verifyHumanGrantFormToken(token, formToken), true);
  assert.equal(await verifyHumanGrantFormToken(`${token.slice(0, -1)}x`, formToken), false);
  const consentHtml = renderHumanGrantConsentPage(row, formToken);
  assert.match(consentHtml, /partner-specific anonymous identifier/u);
  assert.equal(consentHtml.includes(session.subject_id), false);
  assert.equal(consentHtml.includes(session.session_ref), false);

  const approved = await approveHumanGrant(env, row);
  const code = new URL(approved.callback_url).searchParams.get("code")!;
  await assert.rejects(
    exchangeHumanGrant(env, { clientId: "world-id-gateway-demo", clientSecret: "wrong", code }),
    /Invalid partner credentials/u,
  );
  assert.equal(database.grants.get(row.id)?.status, "approved", "bad credentials must not consume the code");

  const envelope = await exchangeHumanGrant(env, {
    clientId: "world-id-gateway-demo",
    clientSecret: env.HUMAN_GATEWAY_DEMO_SECRET!,
    code,
  });
  assert.equal(envelope.assertion.audience, "world-id-gateway-demo");
  assert.equal(envelope.assertion.verified_human, true);
  assert.equal(envelope.assertion.verification_level, "orb");
  assert.match(envelope.assertion.subject, /^hps_[A-Za-z0-9_-]{43}$/u);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(session.subject_id), false);
  assert.equal(serialized.includes(session.session_ref), false);
  assert.equal(database.grants.get(row.id)?.status, "redeemed");

  await assert.rejects(
    exchangeHumanGrant(env, {
      clientId: "world-id-gateway-demo",
      clientSecret: env.HUMAN_GATEWAY_DEMO_SECRET!,
      code,
    }),
    /expired or already used/u,
  );
  const repeated = await createHumanGrant(env, session.subject_id, "gateway-demo", "activate-demo-trial");
  assert.equal(repeated.status, "redeemed");
  assert.equal(database.redemptions.length, 1);
});

test("derives stable pairwise subjects that differ between partners", async () => {
  const key = Buffer.alloc(32, 1).toString("base64url");
  const subject = `wid_${"s".repeat(43)}`;
  const first = await partnerSubject(subject, "partner-one", key);
  assert.equal(await partnerSubject(subject, "partner-one", key), first);
  assert.notEqual(await partnerSubject(subject, "partner-two", key), first);
});
