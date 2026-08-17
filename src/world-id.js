import { hashSignal } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";

export class WorldIdError extends Error {
  constructor(message, { status = 400, details } = {}) {
    super(message);
    this.name = "WorldIdError";
    this.status = status;
    this.details = details;
  }
}

const findBoundResponse = (proof, verificationId) => {
  const expectedSignalHash = hashSignal(verificationId).toLowerCase();
  return proof.responses?.find(
    (item) =>
      typeof item?.signal_hash === "string" &&
      item.signal_hash.toLowerCase() === expectedSignalHash,
  );
};

export function validateProofBinding(
  proof,
  { verificationId, action, environment },
) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new WorldIdError("Malformed World ID proof");
  }
  if (proof.action !== action) {
    throw new WorldIdError("The proof action does not match this application");
  }
  if (proof.environment !== environment) {
    throw new WorldIdError("The proof environment does not match this application");
  }

  const response = findBoundResponse(proof, verificationId);
  if (!response) {
    throw new WorldIdError("The proof is not bound to this verification link");
  }
  if (!new Set(["proof_of_human", "orb"]).has(response.identifier)) {
    throw new WorldIdError("The proof does not establish Proof of Human");
  }

  return response;
}

export function createWorldIdService(config, fetchImpl = fetch) {
  return {
    createRpContext() {
      const { sig, nonce, createdAt, expiresAt } = signRequest({
        signingKeyHex: config.signingKey,
        action: config.action,
      });
      return {
        rp_id: config.rpId,
        sig,
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
      };
    },

    async verifyProof(rawProof, parsedProof, verificationId) {
      const responseItem = validateProofBinding(parsedProof, {
        verificationId,
        action: config.action,
        environment: config.environment,
      });

      const response = await fetchImpl(
        `https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "world-id-chatgpt-mcp-prototype/0.1.0",
          },
          body: rawProof,
        },
      );

      let details;
      try {
        details = await response.json();
      } catch {
        details = null;
      }

      const boundResultSucceeded = details?.results?.some(
        (result) =>
          result?.identifier === responseItem.identifier && result?.success === true,
      );
      if (!response.ok || details?.success !== true || !boundResultSucceeded) {
        throw new WorldIdError("World ID rejected the proof", {
          status: 400,
          details,
        });
      }

      return {
        verified_human: true,
        verification_level: "orb",
        verified_at:
          typeof details.created_at === "string"
            ? details.created_at
            : new Date().toISOString(),
        protocol_version: parsedProof.protocol_version,
        credential: responseItem.identifier,
      };
    },
  };
}
