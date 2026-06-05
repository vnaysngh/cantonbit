/**
 * MAINNET Allocation probe — proves the Canton leg (lock / release / refund) with
 * REAL cBTC. Every prior e2e test SIMULATED the Canton delivery; this is the
 * first time the real allocate/execute/withdraw cycle runs.
 *
 * Test-matrix rows proven (docs/COW-CLONE-TEST-MATRIX.md):
 *   B2 allocate succeeds (real holdings)   B3 solver = sender
 *   B4/B5 solver = executor can release    B7 withdraw refunds
 *   B8 holdings locked while allocated
 *
 * MODE=refund (DEFAULT, NET-ZERO): allocate → assert float dropped (locked) →
 *   withdraw → assert float restored. cBTC never leaves the solver.
 * MODE=happy: allocate → executeTransfer → cBTC goes to SWAP_RECIPIENT_PARTY
 *   (a party you control, so the 0.00001 is recoverable).
 *
 * On ANY error it attempts withdraw so the cBTC can't get stuck.
 *
 * Run (refund first):
 *   MODE=refund npx tsx --env-file=.env --env-file=../.env.local --env-file=.env.mainnet \
 *     src/probe-allocation-mainnet.mts
 */
import assert from "node:assert/strict";

import { CantonClient } from "./canton.js";

assert.equal(process.env.SWAP_NETWORK, "mainnet", "SWAP_NETWORK must be mainnet");
assert.equal(process.env.ALLOW_MAINNET, "true", "ALLOW_MAINNET must be true");
const MODE = (process.env.MODE ?? "refund").toLowerCase();
assert.ok(["happy", "refund"].includes(MODE), "MODE must be happy|refund");

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AMOUNT = "0.00001"; // 1000 sats
const SETTLE_WINDOW_MS = 5 * 60 * 1000; // settleBefore = now + 5m

async function main() {
  const SOLVER = env("SOLVER_CANTON_PARTY");
  const RECIPIENT = env("SWAP_RECIPIENT_PARTY");

  const canton = new CantonClient(
    {
      ledgerHost: env("CANTON_LEDGER_HOST"),
      registryUrl: env("CANTON_REGISTRY_URL"),
      decentralizedPartyId: env("CANTON_ADMIN_PARTY"),
      instrumentId: { admin: env("CANTON_ADMIN_PARTY"), id: process.env.CANTON_INSTRUMENT_ID ?? "CBTC" },
      solverParty: SOLVER,
    },
    {
      tokenUrl: env("KEYCLOAK_TOKEN_URL"),
      clientId: env("KEYCLOAK_CLIENT_ID"),
      clientSecret: env("KEYCLOAK_CLIENT_SECRET"),
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
    },
  );

  console.log(`\n=== MAINNET Allocation probe — MODE=${MODE}, ${AMOUNT} cBTC ===`);
  console.log(`sender/executor: ${SOLVER.slice(0, 28)}…`);
  console.log(`receiver:        ${RECIPIENT.slice(0, 28)}…\n`);

  // 0. baseline float (B8 measurement)
  const floatBefore = await canton.getFloatSats();
  console.log(`[0] float before: ${Number(floatBefore) / 1e8} cBTC (${floatBefore} sats)`);
  assert.ok(floatBefore >= 1000n, "need >= 0.00001 cBTC float");

  // 1. ALLOCATE (B2/B3) — lock the cBTC
  const holdings = await canton.getHoldings(SOLVER);
  console.log(`[1] allocating ${AMOUNT} cBTC (locking)…`);
  const now = Date.now();
  const { allocationCid, lockedHoldingCids } = await canton.allocate({
    receiverParty: RECIPIENT,
    amountBtc: AMOUNT,
    inputHoldings: holdings,
    settlementId: `probe-${MODE}`,
    // allocateBefore MUST be strictly before settleBefore (registry precondition).
    allocateBefore: new Date(now + SETTLE_WINDOW_MS),
    settleBefore: new Date(now + 2 * SETTLE_WINDOW_MS),
  });
  assert.ok(allocationCid, "allocate must return an Allocation contractId");
  console.log(`    ✓ allocation created: ${allocationCid.slice(0, 24)}…`);
  console.log(`    locked holdings: ${lockedHoldingCids.length}`);

  let executed = false;
  try {
    // 2. assert holdings are LOCKED (B8): float should have dropped by the amount
    await sleep(2000);
    const floatLocked = await canton.getFloatSats();
    console.log(`[2] float while allocated: ${Number(floatLocked) / 1e8} cBTC`);
    assert.ok(
      floatLocked <= floatBefore - 1000n,
      `B8 FAILED: float did not drop while allocated (before=${floatBefore}, now=${floatLocked})`,
    );
    console.log(`    ✓ B8: cBTC is locked (float dropped by >= ${AMOUNT})`);

    if (MODE === "happy") {
      // 3a. EXECUTE (B4/B5) — release to receiver
      console.log(`[3] executeTransfer (releasing to receiver)…`);
      const { updateId } = await canton.executeAllocation(allocationCid);
      executed = true;
      console.log(`    ✓ B4/B5: released. updateId=${updateId.slice(0, 24)}…`);
      console.log(`    (0.00001 cBTC now at recipient — recover from that wallet)`);
    } else {
      // 3b. WITHDRAW (B7) — refund to solver
      console.log(`[3] withdraw (refunding to solver)…`);
      const { updateId } = await canton.withdrawAllocation(allocationCid);
      executed = true;
      console.log(`    ✓ withdraw submitted. updateId=${updateId.slice(0, 24)}…`);
      await sleep(2000);
      const floatAfter = await canton.getFloatSats();
      console.log(`[4] float after withdraw: ${Number(floatAfter) / 1e8} cBTC`);
      assert.ok(
        floatAfter >= floatBefore - 100n, // allow tiny rounding/fee dust
        `B7 FAILED: float not restored (before=${floatBefore}, after=${floatAfter})`,
      );
      console.log(`    ✓ B7: cBTC refunded — float restored. NET ZERO.`);
    }
  } finally {
    // SAFETY: if we allocated but never executed/withdrew (crash/assert), refund.
    if (!executed) {
      console.error(`\n[safety] allocation ${allocationCid.slice(0, 20)}… not resolved — attempting withdraw…`);
      try {
        await canton.withdrawAllocation(allocationCid);
        console.error("[safety] ✓ withdraw succeeded — cBTC recovered.");
      } catch (e) {
        console.error(`[safety] ✗ withdraw FAILED — MANUAL RECOVERY NEEDED for ${allocationCid}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`\n=== PROBE PASSED (MODE=${MODE}) ===`);
}

main().catch((e) => {
  console.error("\n[probe] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
