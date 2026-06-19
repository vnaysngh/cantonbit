#!/usr/bin/env npx tsx
/** One-off audit for order 0x83dce0af… — prepare bytes for all 3 Canton legs. */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const ORDER = {
  id: "0x83dce0afce1d79b7f050ef9a0566356919c255359be2514d0220245d6d7f1294",
  solver:
    "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9",
  user: "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9",
  cbtc: "0.00009869",
  allocationCid:
    "001c316f77ee7a05aec023c0b2d3a2a18a713253099a9f3af928465ca7d8bcd0b2ca1212202d15995eb66e8d3327f865e5b31d6ab3c234b4a0f8413ba85b0b38d844e5ade7",
  htlcCid:
    "002a610c73b38293bb07653c2d8c96f1ba4a8138dcd1429e1bb50dfa368ceeb39dca1212205aabf4fdb58ecb885d76e8706438cd8f85886e2ec306564ce46a9e42f6f20f24",
  hashLock:
    "83dce0afce1d79b7f050ef9a0566356919c255359be2514d0220245d6d7f1294",
  preimage: "f5bbb87d998e1a4669a0b5e6c85051a07b983cf0a699eca76a0f800c3d5df18f",
  solverTimelock: 1781793311
};

async function main() {
  const { measureSolverCounterLockTraffic } = await import(
    "../lib/canton-network-fee.js"
  );
  const {
    fetchAmuletPriceUsd,
    fetchExtraTrafficPriceUsdPerMb
  } = await import("../lib/canton-price-scan.js");

  const [amuletUsd, trafficUsdPerMb] = await Promise.all([
    fetchAmuletPriceUsd(),
    fetchExtraTrafficPriceUsdPerMb()
  ]);

  const solverCost = await measureSolverCounterLockTraffic({
    context: "audit-order-83dce0af",
    orderId: ORDER.id,
    solverParty: ORDER.solver,
    userParty: ORDER.user,
    cbtcAmount: ORDER.cbtc,
    allocationCid: ORDER.allocationCid,
    hashLockHex: ORDER.hashLock,
    unlockTime: new Date(ORDER.solverTimelock * 1000 - 60_000)
  });

  const { estimateHtlcManagedFee } = await import("../lib/canton-network-fee.js");
  const claimEstimate = await estimateHtlcManagedFee({
    action: "htlc-claim",
    userParty: ORDER.user,
    solverParty: ORDER.solver,
    cbtcAmount: ORDER.cbtc
  });
  const claimBytes = claimEstimate.trafficBytes;
  const claimUsd = claimEstimate.feeUsd;
  const claimCc = Number.parseFloat(claimEstimate.feeCc);

  console.log(
    JSON.stringify(
      {
        pricing: { amuletUsd, trafficUsdPerMb },
        solverCounterLock: solverCost,
        userClaim: {
          trafficBytes: claimBytes,
          listPriceUsd: claimUsd,
          listPriceCc: claimEstimate.feeCc,
          note: "allocate-proxy prepare (allocation consumed post-swap)"
        },
        totals: {
          trafficBytes: (solverCost?.totalTrafficBytes ?? 0) + claimBytes,
          listPriceUsd:
            (solverCost?.totalFeeUsd ?? 0) + claimUsd,
          listPriceCc:
            parseFloat(solverCost?.totalFeeCc ?? "0") + claimCc
        }
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
