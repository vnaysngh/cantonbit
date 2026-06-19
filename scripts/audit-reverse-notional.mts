#!/usr/bin/env npx tsx
/**
 * Canton→EVM (managed) fee projection at given CBTC input amounts.
 *
 *   AUDIT_USER_CANTON_PARTY=party-… bash scripts/with-env.sh devnet npx tsx scripts/audit-reverse-notional.mts 0.0001 0.00156384
 */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

import { trafficBytesToFeeCc } from "../lib/canton-network-fee-math.js";

const amounts = process.argv.slice(2);
if (amounts.length === 0) amounts.push("0.0001", "0.00156384");

const BTC_USD = Number(process.env.AUDIT_BTC_USD ?? "63945");
const ETH_USD = Number(process.env.AUDIT_ETH_USD ?? "1743.98");
const FEE_BPS = 100;
const solver =
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";
const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_PARTY_ID?.trim() ||
  "";

const EVM = {
  wbtcLockGas: 291_373,
  wbtcLockGasPrice: 6_000_001,
  wbtcClaimGas: 58_417,
  wbtcClaimGasPrice: 6_000_000
};

function evmUsd(gas: number, priceWei: number): number {
  return (gas * priceWei) / 1e18 * ETH_USD;
}

function listPrice(bytes: number, trafficUsdPerMb: number, amuletUsd: number) {
  const feeCc = trafficBytesToFeeCc({
    trafficBytes: bytes,
    extraTrafficPriceUsdPerMb: trafficUsdPerMb,
    amuletPriceUsd: amuletUsd,
    bufferBps: 0
  });
  const feeUsd = (bytes / 1e6) * trafficUsdPerMb;
  return { trafficBytes: bytes, listCc: feeCc, listUsd: feeUsd };
}

async function projectOne(cbtcIn: string) {
  const cbtc = Number.parseFloat(cbtcIn);
  const notionalUsd = cbtc * BTC_USD;
  const platformFeeBtc = (cbtc * FEE_BPS) / 10_000;
  const wbtcOutBtc = cbtc - platformFeeBtc;

  const { estimateHtlcManagedFee } = await import("../lib/canton-network-fee.js");
  const { prepareLedgerCommands } = await import("../lib/transfer.js");
  const {
    buildCreateHtlcLockCommand,
    buildAllocatePrepare,
    findProbeHtlcLock,
    prepareClaimCommand
  } = await import("../lib/htlc-onledger.js");
  const { getHoldings } = await import("../lib/canton.js");
  const { selectHoldingsForAmount } = await import("../lib/transfer-holdings.js");
  const {
    fetchExtraTrafficPriceUsdPerMb,
    fetchAmuletPriceUsd
  } = await import("../lib/canton-price-scan.js");

  const [trafficUsdPerMb, amuletUsd] = await Promise.all([
    fetchExtraTrafficPriceUsdPerMb(),
    fetchAmuletPriceUsd()
  ]);

  const lockQuote = await estimateHtlcManagedFee({
    action: "htlc-lock",
    userParty: user,
    solverParty: solver,
    cbtcAmount: cbtcIn
  });

  const holdings = await getHoldings(user);
  const picked = selectHoldingsForAmount(holdings, cbtcIn, 8, "CBTC");
  const now = Date.now();
  const settleBeforeMs = now + 24 * 60 * 60 * 1000;
  const allocatePrep = await buildAllocatePrepare({
    senderParty: user,
    solverParty: solver,
    receiverParty: solver,
    amountBtc: cbtcIn,
    inputHoldings: picked,
    inputHoldingCids: picked.map((h) => h.contractId),
    settlementId: `rev-audit-${now}`,
    settleBefore: new Date(settleBeforeMs),
    allocateBefore: new Date(Math.min(now + 10 * 60 * 1000, settleBeforeMs - 30_000))
  });
  const allocatePrepResult = await prepareLedgerCommands({
    actAs: [user],
    commands: [allocatePrep.command],
    disclosedContracts: allocatePrep.disclosedContracts,
    synchronizerId: allocatePrep.synchronizerId
  });

  const fakeAlloc =
    "001c316f77ee7a05aec023c0b2d3a2a18a713253099a9f3af928465ca7d8bcd0b2ca1212202d15995eb66e8d3327f865e5b31d6ab3c234b4a0f8413ba85b0b38d844e5ade7";
  const { command: createCmd, actAs: createActAs } = buildCreateHtlcLockCommand({
    solverParty: solver,
    receiverParty: solver,
    lockerParty: user,
    allocationCid: fakeAlloc,
    amountBtc: cbtcIn,
    hashLock: "83dce0afce1d79b7f050ef9a0566356919c255359be2514d0220245d6d7f1294",
    unlockTime: new Date(settleBeforeMs - 60_000)
  });
  const createPrepResult = await prepareLedgerCommands({
    actAs: createActAs,
    commands: [createCmd],
    disclosedContracts: [],
    synchronizerId: allocatePrep.synchronizerId
  });

  let solverClaimBytes = 0;
  const probe = await findProbeHtlcLock(solver);
  if (probe?.htlcCid && probe.allocationCid) {
    try {
      const { command, disclosedContracts } = await prepareClaimCommand({
        htlcCid: probe.htlcCid,
        htlcBlob: probe.htlcBlob,
        allocationCid: probe.allocationCid,
        solverParty: solver,
        preimageHex: "00".repeat(32)
      });
      const claimPrep = await prepareLedgerCommands({
        actAs: [solver],
        commands: [command],
        disclosedContracts
      });
      solverClaimBytes = claimPrep.totalTrafficBytes;
    } catch {
      /* fallback below */
    }
  }
  if (solverClaimBytes <= 0) {
    const fwdClaim = await estimateHtlcManagedFee({
      action: "htlc-claim",
      userParty: user,
      solverParty: solver,
      cbtcAmount: cbtcIn
    });
    solverClaimBytes = fwdClaim.trafficBytes;
  }

  const userAllocate = listPrice(allocatePrepResult.totalTrafficBytes, trafficUsdPerMb, amuletUsd);
  const userCreate = listPrice(createPrepResult.totalTrafficBytes, trafficUsdPerMb, amuletUsd);
  const solverClaim = listPrice(solverClaimBytes, trafficUsdPerMb, amuletUsd);
  const userLockTotalBytes =
    allocatePrepResult.totalTrafficBytes + createPrepResult.totalTrafficBytes;
  const cantonTotalBytes = userLockTotalBytes + solverClaimBytes;

  const solverEvmLockUsd = evmUsd(EVM.wbtcLockGas, EVM.wbtcLockGasPrice);
  const userEvmClaimUsd = evmUsd(EVM.wbtcClaimGas, EVM.wbtcClaimGasPrice);
  const platformRevenueUsd = platformFeeBtc * BTC_USD;
  const nodeCostListUsd =
    userAllocate.listUsd + userCreate.listUsd + solverClaim.listUsd + solverEvmLockUsd;

  return {
    direction: "canton-to-evm",
    cbtcIn,
    notionalUsd: notionalUsd.toFixed(2),
    wbtcOutBtc: wbtcOutBtc.toFixed(8),
    platformFeeBtc: platformFeeBtc.toFixed(8),
    platformRevenueUsd: platformRevenueUsd.toFixed(2),
    canton: {
      legs: [
        {
          id: "user-lock-allocate",
          actAs: "user",
          ...userAllocate,
          userNetworkFeeQuoteUsd: lockQuote.feeUsd,
          userNetworkFeeQuoteBytes: lockQuote.trafficBytes
        },
        { id: "user-lock-create-htlc", actAs: "user", ...userCreate },
        { id: "solver-claim-cbtc", actAs: "solver", ...solverClaim }
      ],
      userTwoTxsListUsd: (userAllocate.listUsd + userCreate.listUsd).toFixed(2),
      solverOneTxListUsd: solverClaim.listUsd.toFixed(2),
      totalThreeTxsBytes: cantonTotalBytes,
      totalThreeTxsListUsd: (
        userAllocate.listUsd +
        userCreate.listUsd +
        solverClaim.listUsd
      ).toFixed(2)
    },
    evm: {
      solverWbtcLockUsd: solverEvmLockUsd.toFixed(4),
      userWbtcClaimUsd: userEvmClaimUsd.toFixed(4)
    },
    marginUsd: {
      nodeCostListUsd: nodeCostListUsd.toFixed(2),
      net_noUserNetworkFee: (platformRevenueUsd - nodeCostListUsd).toFixed(2),
      net_ifUserPaysLockNetworkFee: (
        platformRevenueUsd +
        lockQuote.feeUsd -
        nodeCostListUsd
      ).toFixed(2)
    }
  };
}

async function main() {
  if (!solver || !user) throw new Error("Set SOLVER_CANTON_PARTY and AUDIT_USER_CANTON_PARTY");
  const flows = [];
  for (const a of amounts) flows.push(await projectOne(a));
  console.log(JSON.stringify({ pricing: { btcUsd: BTC_USD, ethUsd: ETH_USD }, flows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
