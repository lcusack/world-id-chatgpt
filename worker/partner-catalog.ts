import type { OfficialWorldIdBenefit } from "./world-id-benefit-catalog";
import type { PartnerId } from "./partner-registry";

export function integratedProviderForBenefit(benefit: OfficialWorldIdBenefit): PartnerId | null {
  const name = benefit.name.toLocaleLowerCase("en-US");
  let hostname = "";
  try {
    hostname = new URL(benefit.appUrl).hostname.toLocaleLowerCase("en-US");
  } catch {
    return null;
  }
  if (hostname === "agentmail.to" || hostname.endsWith(".agentmail.to") || name.includes("agentmail")) return "agentmail";
  if (hostname === "maitre.fun" || hostname.endsWith(".maitre.fun") || name.includes("maître") || name.includes("maitre")) return "maitre";
  return null;
}
