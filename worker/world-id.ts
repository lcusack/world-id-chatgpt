import { signRequest } from "@worldcoin/idkit-core/signing";
import type { Env, VerifiedSessionProof } from "./types";

const SESSION_ID_PATTERN = /^session_[0-9a-fA-F]{128}$/u;

interface SessionResponseItem {
  identifier?: unknown;
  proof?: unknown;
  session_nullifier?: unknown;
  issuer_schema_id?: unknown;
}

interface SessionProof {
  protocol_version?: unknown;
  nonce?: unknown;
  action?: unknown;
  session_id?: unknown;
  responses?: unknown;
  environment?: unknown;
  user_presence_completed?: unknown;
}

export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export function createRpContext(signingKey: string) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: signingKey,
    ttl: 300,
  });
  return { sig, nonce, createdAt, expiresAt };
}

export function validateSessionProof(
  proof: SessionProof,
  expectedNonce: string,
  expectedEnvironment: string,
): { sessionId: string; replayValue: string; response: SessionResponseItem } {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new PublicError("Malformed World ID proof");
  }
  if (proof.protocol_version !== "4.0") {
    throw new PublicError("Only World ID 4.0 session proofs are accepted");
  }
  if (proof.action !== undefined) {
    throw new PublicError("A uniqueness proof cannot be used to link an account");
  }
  if (proof.environment !== expectedEnvironment) {
    throw new PublicError("The proof environment does not match this application");
  }
  if (typeof proof.nonce !== "string" || proof.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
    throw new PublicError("The proof is not bound to this authorization request");
  }
  if (proof.user_presence_completed !== true) {
    throw new PublicError("World App did not complete the required presence check");
  }
  if (typeof proof.session_id !== "string" || !SESSION_ID_PATTERN.test(proof.session_id)) {
    throw new PublicError("World App returned an invalid session identifier");
  }
  if (!Array.isArray(proof.responses)) {
    throw new PublicError("World App returned no credential responses");
  }

  const response = (proof.responses as SessionResponseItem[]).find(
    (item) => item?.identifier === "proof_of_human",
  );
  if (!response || response.issuer_schema_id !== 1) {
    throw new PublicError("The proof does not establish Orb-backed Proof of Human");
  }
  // World is the cryptographic authority for the proof encoding. Keep local
  // checks structural so SDK/credential encoding changes are forwarded as-is.
  if (!Array.isArray(response.proof) || response.proof.length === 0 || response.proof.length > 16 || !response.proof.every((part) => typeof part === "string" && part.length > 0 && part.length <= 16_384)) {
    throw new PublicError("World App returned a malformed Proof of Human response");
  }
  if (!Array.isArray(response.session_nullifier) || response.session_nullifier.length === 0 || response.session_nullifier.length > 8 || !response.session_nullifier.every((part) => typeof part === "string" && part.length > 0 && part.length <= 1_024)) {
    throw new PublicError("World App returned a malformed session nullifier");
  }

  const replayValue = response.session_nullifier
    .map((part) => part.toLowerCase())
    .map((part) => `${part.length}:${part}`)
    .join("|");

  return {
    sessionId: proof.session_id,
    replayValue,
    response,
  };
}

export async function verifyWorldSessionProof(
  env: Env,
  rawProof: string,
  parsedProof: SessionProof,
  expectedNonce: string,
): Promise<VerifiedSessionProof> {
  const validated = validateSessionProof(parsedProof, expectedNonce, env.WORLD_ENVIRONMENT);
  const response = await fetch(
    `https://developer.world.org/api/v4/verify/${encodeURIComponent(env.WORLD_RP_ID)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "world-id-chatgpt/1.0",
      },
      body: rawProof,
      signal: AbortSignal.timeout(10_000),
    },
  );

  const details = await response.json().catch(() => null) as {
    success?: boolean;
    results?: Array<{ identifier?: string; success?: boolean }>;
  } | null;
  const credentialSucceeded = details?.results?.some(
    (result) => result.identifier === "proof_of_human" && result.success === true,
  );
  if (!response.ok || details?.success !== true || !credentialSucceeded) {
    throw new PublicError("World ID rejected the proof");
  }

  return {
    sessionId: validated.sessionId,
    replayValue: validated.replayValue,
    credential: "proof_of_human",
    protocolVersion: "4.0",
    verifiedAt: Math.floor(Date.now() / 1000),
  };
}
