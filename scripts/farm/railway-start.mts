#!/usr/bin/env npx tsx
/**
 * Railway entrypoint — continuous CBTC farm bot.
 * Env vars replace .env.mainnet + .farm-fleet.mainnet.json on disk.
 */
import { ensureFleetFile, farmDataDir } from "./lib/config";
import { auditMainnetConfig, printAudit } from "./lib/mainnet-audit";
import { runFarmBot } from "./run";

function bootstrapArgv(): void {
  if (!process.argv.includes("--i-understand-mainnet")) {
    process.argv.push("--i-understand-mainnet");
  }
  if (!process.argv.includes("--bitsafe-eligible-confirmed")) {
    process.argv.push("--bitsafe-eligible-confirmed");
  }
  if (!process.argv.some((a) => a.startsWith("--max-swaps="))) {
    const max = process.env.FARM_MAX_SWAPS?.trim() || "0";
    process.argv.push(`--max-swaps=${max}`);
  }
}

async function main(): Promise<void> {
  bootstrapArgv();

  if (!process.env.NEXT_PUBLIC_NETWORK) {
    process.env.NEXT_PUBLIC_NETWORK = "mainnet";
  }
  if (!process.env.BITSAFE_FARMING_ELIGIBLE) {
    process.env.BITSAFE_FARMING_ELIGIBLE = "1";
  }

  console.log(`[farm] data dir: ${farmDataDir()}`);
  ensureFleetFile();

  const audit = auditMainnetConfig();
  printAudit(audit);
  if (!audit.ok) process.exit(1);

  await runFarmBot();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
