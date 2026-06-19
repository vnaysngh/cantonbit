#!/usr/bin/env npx tsx
/** Project EVM + Canton costs at a USD notional (prepare-based Canton bytes). */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const NOTIONAL_USD = Number(process.argv[2] ?? "100");
const BTC_USD = Number(process.argv[3] ?? "63945");
const ETH_USD = Number(process.argv[4] ?? "1743.98");
const FEE_BPS = 100; // 1%

const solver =
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_PARTY_ID?.trim() ||
  "";

async function main() {
  if (!solver || !user) throw new Error("Set SOLVER_CANTON_PARTY and AUDIT_USER_CANTON_PARTY");

  const wbtcBtc = NOTIONAL_USD / BTC_USD;
  const platformFeeBtc = (wbtcBtc * FEE_BPS) / 10_000;
  const cbtcBtc = wbtcBtc - platformFeeBtc;

  // Actual EVM gas from swap 0x83dce0af (fixed regardless of amount)
  const userLockUsd = (291_373 * 6_000_001) / 1e18 * ETH_USD;
  const solverClaimUsd = (58_417 * 6_000_000) / 1e18 * ETH_USD;

  const { measureSolverCounterLockTraffic, estimateHtlcManagedFee } = await import(
    "../lib/canton-network-fee.js"
  );

  const solverCost = await measureSolverCounterLockTraffic({
    context: "notional-projection",
    solverParty: solver,
    userParty: user,
    cbtcAmount: cbtcBtc.toFixed(8),
    allocationCid: "001c316f77ee7a05aec023c0b2d3a2a18a713253099a9f3af928465ca7d8bcd0b2ca1212202d15995eb66e8d3327f865e5b31d6ab3c234b4a0f8413ba85b0b38d844e5ade7",
    hashLockHex: "83dce0afce1d79b7f050ef9a0566356919c255359be2514d0220245d6d7f1294",
    unlockTime: new Date(Date.now() + 3600_000)
  });

  const claimEstimate = await estimateHtlcManagedFee({
    action: "htlc-claim",
    userParty: user,
    solverParty: solver,
    cbtcAmount: cbtcBtc.toFixed(8)
  });

  const cantonSolverUsd = solverCost?.totalFeeUsd ?? 0;
  const cantonClaimUsd = claimEstimate.feeUsd;
  const cantonTotalUsd = cantonSolverUsd + cantonClaimUsd;
  const cantonTotalBytes =
    (solverCost?.totalTrafficBytes ?? 0) + claimEstimate.trafficBytes;

  const platformRevenueUsd = platformFeeBtc * BTC_USD;
  const solverOpsUsd = cantonSolverUsd + solverClaimUsd;
  const userNetworkFeeUsd = cantonClaimUsd; // if enabled at list price, no buffer
  const userNetworkFeeBufferedUsd = userNetworkFeeUsd * 1.15; // 15% buffer default

  const netPlatformIfSubsidizeAllCanton =
    platformRevenueUsd - cantonSolverUsd - solverClaimUsd;
  const netPlatformIfChargeUserClaimOnly =
    platformRevenueUsd + userNetworkFeeUsd - cantonSolverUsd - solverClaimUsd;
  const netPlatformIfChargeUserClaimBuffered =
    platformRevenueUsd + userNetworkFeeBufferedUsd - cantonSolverUsd - solverClaimUsd;

  console.log(
    JSON.stringify(
      {
        inputs: { notionalUsd: NOTIONAL_USD, btcUsd: BTC_USD, ethUsd: ETH_USD, feeBps: FEE_BPS },
        swapAmounts: {
          wbtcBtc: wbtcBtc.toFixed(8),
          cbtcBtc: cbtcBtc.toFixed(8),
          platformFeeBtc: platformFeeBtc.toFixed(8),
          platformRevenueUsd: platformRevenueUsd.toFixed(2)
        },
        evm: {
          userWbtcLockUsd: userLockUsd.toFixed(4),
          solverWbtcClaimUsd: solverClaimUsd.toFixed(4),
          note: "Gas fixed per tx — same as 0.0001 BTC swap"
        },
        cantonListPrice: {
          solverTwoTxs: solverCost,
          userClaim: {
            trafficBytes: claimEstimate.trafficBytes,
            feeCc: claimEstimate.feeCc,
            feeUsd: claimEstimate.feeUsd
          },
          totalTrafficBytes: cantonTotalBytes,
          totalListUsd: cantonTotalUsd.toFixed(2)
        },
        costSummaryUsd: {
          solverOpsCantonPlusEvm: (cantonSolverUsd + solverClaimUsd).toFixed(2),
          allCantonThreeTxs: cantonTotalUsd.toFixed(2),
          userPaysEvmOnly: userLockUsd.toFixed(4)
        },
        marginUsd: {
          platformRevenue: platformRevenueUsd.toFixed(2),
          minusSolverOps_noUserFee: netPlatformIfSubsidizeAllCanton.toFixed(2),
          ifUserPaysClaimNetworkFee_list: netPlatformIfChargeUserClaimOnly.toFixed(2),
          ifUserPaysClaimNetworkFee_15pctBuffer: netPlatformIfChargeUserClaimBuffered.toFixed(2)
        },
        breakEvenNote:
          "Solver ops ≈ fixed ~$1.30 list Canton+$0.61 EVM. Platform 1% scales with notional. User claim fee (~$0.50) does not cover solver Canton (~$0.69)."
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
