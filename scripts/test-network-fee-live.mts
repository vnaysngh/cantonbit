#!/usr/bin/env npx tsx
/**
 * Live integration test for prepare-based network fee estimates (devnet/mainnet env).
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/test-network-fee-live.mts
 */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

type Check = { name: string; pass: boolean; detail: string };

async function main() {
  const checks: Check[] = [];
  const solver =
    process.env.SOLVER_CANTON_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
    "";
  const user =
    process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
    process.env.CANTON_SWAP_TEST_USER_PARTY?.trim() ||
    process.env.NEXT_PUBLIC_PARTY_ID?.trim() ||
    "";

  if (!solver) throw new Error("SOLVER_CANTON_PARTY missing");
  if (!user) throw new Error("Set NEXT_PUBLIC_PARTY_ID or AUDIT_USER_CANTON_PARTY");

  const { findProbeHtlcLock } = await import("../lib/htlc-onledger.js");
  const { estimateHtlcManagedFee } = await import("../lib/canton-network-fee.js");

  const probe = await findProbeHtlcLock(solver);
  checks.push({
    name: "findProbeHtlcLock (optional)",
    pass: true,
    detail: probe
      ? `htlc=${probe.htlcCid.slice(0, 16)}… alloc=${probe.allocationCid.slice(0, 16)}…`
      : "none with live allocation + future timelock (quote uses allocate proxy)"
  });

  try {
    const { measureSolverCounterLockTraffic } = await import(
      "../lib/canton-network-fee.js"
    );
    const solverCost = await measureSolverCounterLockTraffic({
      context: "live-test",
      solverParty: solver,
      userParty: user,
      cbtcAmount: "0.0001"
    });
    checks.push({
      name: "measureSolverCounterLockTraffic (allocate-only projection)",
      pass: solverCost != null && solverCost.totalTrafficBytes > 0,
      detail: solverCost
        ? `${solverCost.totalTrafficBytes} bytes → ${solverCost.totalFeeCc} CC (~$${solverCost.totalFeeUsd.toFixed(2)}) list price`
        : "measure returned null"
    });
  } catch (e) {
    checks.push({
      name: "measureSolverCounterLockTraffic (allocate-only projection)",
      pass: false,
      detail: e instanceof Error ? e.message : String(e)
    });
  }

  try {
    const claim = await estimateHtlcManagedFee({
      action: "htlc-claim",
      userParty: user,
      solverParty: solver,
      cbtcAmount: "0.0001"
    });
    const charged =
      claim.transactions?.find((t) => t.id === "htlc-claim")?.trafficBytes ??
      claim.trafficBytes;
    checks.push({
      name: "estimateHtlcManagedFee htlc-claim (prepare)",
      pass:
        claim.networkFeeSource === "prepare" &&
        claim.trafficBytes > 0 &&
        Number.parseFloat(claim.feeCc) > 0,
      detail: `${charged} bytes → ${claim.feeCc} CC (~$${claim.feeUsd.toFixed(2)})`
    });
  } catch (e) {
    checks.push({
      name: "estimateHtlcManagedFee htlc-claim (prepare)",
      pass: false,
      detail: e instanceof Error ? e.message : String(e)
    });
  }

  if (probe) {
    try {
      const claimReal = await estimateHtlcManagedFee({
        action: "htlc-claim",
        userParty: user,
        solverParty: solver,
        cbtcAmount: "0.0001",
        htlcCid: probe.htlcCid,
        allocationCid: probe.allocationCid,
        htlcBlob: probe.htlcBlob,
        preimageHex: process.env.NETWORK_FEE_PROBE_PREIMAGE_HEX?.trim()
      });
      if (process.env.NETWORK_FEE_PROBE_PREIMAGE_HEX?.trim()) {
        checks.push({
          name: "estimateHtlcManagedFee htlc-claim (real order CIDs + preimage)",
          pass: claimReal.networkFeeSource === "prepare" && claimReal.trafficBytes > 0,
          detail: `${claimReal.trafficBytes} bytes → ${claimReal.feeCc} CC`
        });
      }
    } catch {
      // optional when preimage env not set
    }
  }

  try {
    const lock = await estimateHtlcManagedFee({
      action: "htlc-lock",
      userParty: user,
      solverParty: solver,
      cbtcAmount: "0.0001"
    });
    const charged =
      lock.transactions?.find((t) => t.id === "htlc-lock-create")
        ?.trafficBytes ?? lock.trafficBytes;
    checks.push({
      name: "estimateHtlcManagedFee htlc-lock (prepare)",
      pass:
        lock.networkFeeSource === "prepare" &&
        lock.trafficBytes > 0 &&
        Number.parseFloat(lock.feeCc) > 0,
      detail: `${charged} bytes → ${lock.feeCc} CC (~$${lock.feeUsd.toFixed(2)})`
    });
  } catch (e) {
    checks.push({
      name: "estimateHtlcManagedFee htlc-lock (prepare)",
      pass: false,
      detail: e instanceof Error ? e.message : String(e)
    });
  }

  console.log("\n=== Live network fee prepare tests ===\n");
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll live prepare tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
