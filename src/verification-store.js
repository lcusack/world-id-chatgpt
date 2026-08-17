import { randomBytes } from "node:crypto";

export class VerificationStore {
  #attempts = new Map();
  #now;
  #ttlMs;

  constructor({ ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  create() {
    const now = this.#now();
    const attempt = {
      id: randomBytes(24).toString("base64url"),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
      claims: null,
    };
    this.#attempts.set(attempt.id, attempt);
    return structuredClone(attempt);
  }

  get(id) {
    const attempt = this.#attempts.get(id);
    if (!attempt) return null;

    if (
      attempt.status === "pending" &&
      this.#now() >= Date.parse(attempt.expiresAt)
    ) {
      attempt.status = "expired";
    }

    return structuredClone(attempt);
  }

  markVerified(id, claims) {
    const attempt = this.#attempts.get(id);
    if (!attempt) return null;
    if (this.get(id)?.status !== "pending") return this.get(id);

    attempt.status = "verified";
    attempt.claims = structuredClone(claims);
    return structuredClone(attempt);
  }
}
