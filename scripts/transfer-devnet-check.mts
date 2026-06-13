#!/usr/bin/env npx tsx
/**
 * Devnet transfer stack sanity check (no browser session required).
 * Validates env, registry reachability, and unit tests for holdings selection.
 *
 * Usage: npm run transfer:check:devnet
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { NETWORK } from "../lib/constants";

console.log("=== Transfer devnet check ===\n");
console.log(`Network: ${NETWORK.name}`);
console.log(`Ledger:  ${NETWORK.ledgerHost}`);
console.log(`Registry: ${NETWORK.registryUrl}`);

assert.ok(NETWORK.registryUrl.startsWith("https://"), "registry URL");
assert.ok(NETWORK.ledgerHost.startsWith("https://"), "ledger host");

const registryProbe = `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${NETWORK.decentralizedPartyId}/registry/metadata/v1/instruments`;
console.log(`\nProbing registry metadata…`);
const res = await fetch(registryProbe, { cache: "no-store" });
console.log(`Registry metadata: ${res.status}`);
if (!res.ok) {
  console.error("Registry probe failed — check network / REGISTRY_URL");
  process.exit(1);
}

console.log("\nRunning transfer-holdings unit tests…");
const test = spawnSync(
  "node",
  ["--import", "tsx", "--test", "lib/transfer-holdings.test.ts"],
  { stdio: "inherit", cwd: process.cwd() }
);
if (test.status !== 0) process.exit(test.status ?? 1);

console.log("\n✓ Automated checks passed.");
console.log("\nManual devnet E2E (requires logged-in email user with CBTC):");
console.log("  1. npm run dev:devnet → open /balances");
console.log("  2. Transfer 0.00001 CBTC to an external Canton party");
console.log("  3. Verify Transfers tab (incoming/outgoing) and History tab");
console.log("  See docs/devnet-transfer-audit.md for full checklist.");
