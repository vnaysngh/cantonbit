import { NETWORK } from "../../../lib/constants";
import { vaultParty, treasuryParty } from "./config";

export interface MainnetAuditResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

/** Validate env + constants before mainnet farm operations. */
export function auditMainnetConfig(): MainnetAuditResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (NETWORK.name !== "mainnet") {
    issues.push(`NEXT_PUBLIC_NETWORK must be mainnet (got ${NETWORK.name})`);
  }

  const requiredEnv = [
    "KEYCLOAK_TOKEN_URL",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET",
    "CANTON_SWAP_SETTLEMENT_PARTY",
  ] as const;

  for (const key of requiredEnv) {
    if (!process.env[key]?.trim()) {
      issues.push(`Missing env: ${key}`);
    }
  }

  if (
    !process.env.SOLVER_CANTON_PARTY?.trim() &&
    !process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim()
  ) {
    issues.push("Missing treasury party: SOLVER_CANTON_PARTY or NEXT_PUBLIC_SOLVER_CANTON");
  }

  if (!NETWORK.warpxPartyId) {
    issues.push("NETWORK.warpxPartyId unset for mainnet");
  }

  if (!NETWORK.decentralizedPartyId.includes("cbtc-network::")) {
    warnings.push("Unexpected decentralizedPartyId admin prefix");
  }

  try {
    vaultParty();
    treasuryParty();
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  if (!process.env.CC_REGISTRY_URL?.trim()) {
    warnings.push(
      "CC_REGISTRY_URL unset — using default mainnet scan URL from lib/constants.ts"
    );
  }

  return { ok: issues.length === 0, issues, warnings };
}

export function printAudit(result: MainnetAuditResult): void {
  console.log(`Network: ${NETWORK.name}`);
  console.log(`Ledger:  ${NETWORK.ledgerHost}`);
  console.log(`Registry: ${NETWORK.registryUrl}`);
  console.log(`CC scan: ${NETWORK.ccRegistryUrl}`);
  console.log(`WarpX party: ${NETWORK.warpxPartyId.slice(0, 40)}…`);
  if (result.warnings.length) {
    console.warn("\nWarnings:");
    for (const w of result.warnings) console.warn(`  • ${w}`);
  }
  if (result.issues.length) {
    console.error("\nBlockers:");
    for (const i of result.issues) console.error(`  • ${i}`);
  } else {
    console.log("\n✓ Mainnet config audit passed.");
  }
}
