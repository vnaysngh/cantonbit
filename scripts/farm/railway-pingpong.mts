#!/usr/bin/env npx tsx
/**
 * Railway entrypoint — continuous ping-pong CBTC farm.
 * Mirrors railway-start.mts but runs runPingPong() (derangement traffic farm)
 * instead of the CBTC↔CC swap bot. Env vars replace .env.mainnet +
 * .farm-fleet.mainnet.json on disk; the fleet is materialized from
 * FARM_FLEET_JSON / FARM_FLEET_JSON_B64.
 *
 * Tunables via env (all optional):
 *   PINGPONG_UTILIZATION      → --utilization   (default 0.5, shared-bucket safe)
 *   PINGPONG_BYTES_PER_TX     → --bytes-per-transfer (default 9457)
 *   PINGPONG_CONSOLIDATE_EVERY→ --consolidate-every  (default 2)
 *   PINGPONG_MIN / PINGPONG_MAX → --min / --max CBTC per leg
 *   PINGPONG_CYCLES           → --cycles        (default 0 = loop forever)
 */
import { ensureFleetFile, farmDataDir } from "./lib/config";
import { auditMainnetConfig, printAudit } from "./lib/mainnet-audit";
import { assertNodeVersion } from "./lib/node-guard";
import { runPingPong } from "./pingpong";

function pushFlagFromEnv(flag: string, envKey: string): void {
  const v = process.env[envKey]?.trim();
  if (v && !process.argv.some((a) => a.startsWith(`--${flag}=`))) {
    process.argv.push(`--${flag}=${v}`);
  }
}

function bootstrapArgv(): void {
  if (!process.argv.includes("--i-understand-mainnet")) {
    process.argv.push("--i-understand-mainnet");
  }
  pushFlagFromEnv("utilization", "PINGPONG_UTILIZATION");
  pushFlagFromEnv("bytes-per-transfer", "PINGPONG_BYTES_PER_TX");
  pushFlagFromEnv("consolidate-every", "PINGPONG_CONSOLIDATE_EVERY");
  pushFlagFromEnv("min", "PINGPONG_MIN");
  pushFlagFromEnv("max", "PINGPONG_MAX");
  pushFlagFromEnv("cycles", "PINGPONG_CYCLES");
}

async function main(): Promise<void> {
  assertNodeVersion();
  bootstrapArgv();

  if (!process.env.NEXT_PUBLIC_NETWORK) {
    process.env.NEXT_PUBLIC_NETWORK = "mainnet";
  }
  if (!process.env.BITSAFE_FARMING_ELIGIBLE) {
    process.env.BITSAFE_FARMING_ELIGIBLE = "1";
  }

  console.log(`[pingpong] data dir: ${farmDataDir()}`);
  ensureFleetFile();

  const audit = auditMainnetConfig();
  printAudit(audit);
  if (!audit.ok) process.exit(1);

  await runPingPong();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
