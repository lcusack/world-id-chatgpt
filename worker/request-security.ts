import { sha256, timingSafeEqual } from "./crypto.ts";

const WORLD_AGENT_FORM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function createWorldAgentClaimFormToken(claimToken: string): Promise<string> {
  return sha256(`world-agent-claim-form:${claimToken}`);
}

export async function verifyWorldAgentClaimFormToken(claimToken: string, formToken: string | null): Promise<boolean> {
  if (!formToken || !WORLD_AGENT_FORM_TOKEN_PATTERN.test(formToken)) return false;
  return timingSafeEqual(await createWorldAgentClaimFormToken(claimToken), formToken);
}
