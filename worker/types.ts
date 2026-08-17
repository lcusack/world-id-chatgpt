import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type WorldEnvironment = "production";

export interface AuthProps {
  subjectId: string;
  verifiedHuman: true;
  verificationLevel: "orb";
  protocolVersion: "4.0";
  verifiedAt: string;
  canWriteWall: boolean;
}

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ASSETS: Fetcher;
  AUTH_RATE_LIMITER: RateLimit;
  PROOF_RATE_LIMITER: RateLimit;
  MCP_RATE_LIMITER: RateLimit;
  WALL_RATE_LIMITER: RateLimit;
  CLAIM_RATE_LIMITER: RateLimit;
  INTENT_RATE_LIMITER: RateLimit;
  GRANT_RATE_LIMITER: RateLimit;
  WORLD_APP_ID: string;
  WORLD_RP_ID: string;
  WORLD_ENVIRONMENT: WorldEnvironment;
  WORLD_RP_SIGNING_KEY: string;
  DATA_ENCRYPTION_KEY: string;
  SUBJECT_HMAC_KEY: string;
  PUBLIC_ORIGIN: string;
  HUMAN_REQUIRED_ORIGIN: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_API_VERSION?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  HUMAN_GATEWAY_DEMO_SECRET?: string;
}

export interface AttemptRow {
  id: string;
  csrf_hash: string;
  oauth_request_ciphertext: string;
  oauth_request_iv: string;
  client_name: string;
  mode: "create_session" | "prove_session";
  session_ref: string | null;
  rp_nonce: string | null;
  rp_signature: string | null;
  rp_created_at: number | null;
  rp_expires_at: number | null;
  status: "pending" | "proof_verified" | "completed" | "failed";
  subject_id: string | null;
  credential: string | null;
  protocol_version: string | null;
  verified_at: number | null;
  created_at: number;
  expires_at: number;
  world_agent_referrer_number: number | null;
}

export interface WorldAgentRow {
  agent_number: number;
  subject_id: string;
  share_slug: string;
  registered_at: number;
  claimed_at: number | null;
  referred_by_agent_number: number | null;
}

export interface SessionRow {
  session_ref: string;
  subject_id: string;
  session_id_ciphertext: string;
  session_id_iv: string;
  created_at: number;
  last_verified_at: number;
}

export interface SealedValue {
  ciphertext: string;
  iv: string;
}

export interface StoredOAuthRequest {
  request: AuthRequest;
}

export interface VerifiedSessionProof {
  sessionId: string;
  replayValue: string;
  credential: "proof_of_human";
  protocolVersion: "4.0";
  verifiedAt: number;
}

export interface HumanDealClaimRow {
  ticket_hash: string;
  ticket_ciphertext: string;
  ticket_iv: string;
  subject_id: string;
  deal_id: "unique-human-sf-15";
  target_path: string;
  discount_code_ciphertext: string;
  discount_code_iv: string;
  status: "pending" | "processing" | "ready" | "failed";
  shopify_discount_id: string | null;
  last_error_code: string | null;
  created_at: number;
  ticket_expires_at: number;
  discount_expires_at: number | null;
  redeemed_at: number | null;
}

export interface HumanIntentRow {
  id: string;
  token_hash: string;
  subject_id: string;
  session_ref: string;
  intent_ciphertext: string;
  intent_iv: string;
  intent_hash: string;
  status: "pending" | "approved";
  rp_nonce: string | null;
  rp_signature: string | null;
  rp_created_at: number | null;
  rp_expires_at: number | null;
  created_at: number;
  approval_expires_at: number;
  valid_until: number | null;
  approved_at: number | null;
  receipt_signature: string | null;
}

export interface HumanGrantRow {
  id: string;
  consent_token_hash: string;
  consent_token_ciphertext: string;
  consent_token_iv: string;
  subject_id: string;
  session_ref: string;
  partner_id: string;
  action_id: string;
  partner_subject: string;
  status: "pending" | "approved" | "redeemed";
  created_at: number;
  consent_expires_at: number;
  approved_at: number | null;
  code_hash: string | null;
  code_expires_at: number | null;
  redeemed_at: number | null;
}
