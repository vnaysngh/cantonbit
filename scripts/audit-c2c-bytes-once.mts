#!/usr/bin/env npx tsx
/**
 * Managed C2C prepare byte audit (per-command sum when multi-command prepare unsupported).
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-c2c-bytes-once.mts
 */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

import { trafficBytesToFeeCc } from "../lib/canton-network-fee-math.js";

const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const vault = process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() || "";
const PRICE_MB = 60;
const FEE_BPS = 100;

async function prep(
  label: string,
  actAs: string[],
  commands: unknown[],
  disclosed: unknown[],
  sync?: string
) {
  const { prepareLedgerCommands } = await import("../lib/transfer.js");
  const r = await prepareLedgerCommands({
    actAs,
    commands,
    disclosedContracts: disclosed as never[],
    synchronizerId: sync,
    commandId: `audit-${label}-${Date.now()}`
  });
  return r.totalTrafficBytes;
}

async function ensureProbeOffer(asset: "CBTC" | "CC"): Promise<string> {
  const { findOfferFromSender, buildTransferExercise, submitLedgerCommands } =
    await import("../lib/transfer.js");
  const { extractCreatedOfferCid } = await import("../lib/mint-processor-logic.js");
  const {
    holdingsForSwapAsset,
    resolveSwapInstrumentId,
    registrarAdminForAsset,
    registryKindForAsset
  } = await import("../lib/canton-swap-holdings.js");
  const { getSwapAsset } = await import("../lib/canton-assets.js");

  const existing = await findOfferFromSender(user, vault);
  if (existing) {
    // Reuse only if we cannot distinguish asset — submit fresh tiny offer per asset run.
  }

  const probeAmount = asset === "CBTC" ? "0.00000001" : "0.000001";
  const sym = getSwapAsset(asset);
  const leg = await buildTransferExercise({
    senderParty: user,
    receiverParty: vault,
    amount: probeAmount,
    inputHoldings: await holdingsForSwapAsset(user, asset),
    expirationSeconds: 3600,
    instrumentId: await resolveSwapInstrumentId(asset),
    registrarAdmin: await registrarAdminForAsset(asset),
    registryKind: registryKindForAsset(asset),
    assetSymbol: sym.symbol,
    memo: `fee-audit-probe-${asset}`
  });
  if (!leg.transferKind.toLowerCase().includes("offer")) {
    throw new Error(`Probe ${asset} leg is ${leg.transferKind}, expected offer`);
  }

  const commandId = `c2c-fee-probe-${asset}-${Date.now()}`;
  const { eventsById } = await submitLedgerCommands({
    actAs: [user],
    commands: [leg.command],
    disclosedContracts: leg.disclosedContracts,
    commandId,
    workflowId: commandId,
    applicationId: "canton-swap",
    synchronizerId: leg.synchronizerId || undefined
  });
  const cid =
    extractCreatedOfferCid(eventsById) ?? (await findOfferFromSender(user, vault));
  if (!cid) throw new Error(`No probe offer cid for ${asset}`);
  return cid;
}

async function measureScenario(
  fromAsset: "CBTC" | "CC",
  toAsset: "CBTC" | "CC",
  inAmount: string,
  label: string
) {
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const { computeC2cSwapNotionalUsd } = await import("../lib/canton-network-fee.js");
  const { buildTransferExercise, buildAcceptExercise } = await import("../lib/transfer.js");
  const { getSwapAsset } = await import("../lib/canton-assets.js");
  const {
    holdingsForSwapAsset,
    resolveSwapInstrumentId,
    registrarAdminForAsset,
    registryKindForAsset
  } = await import("../lib/canton-swap-holdings.js");
  const { previewManagedSwapReadiness } = await import("../lib/canton-swap-preapproval.js");

  const quote = await quoteMvpCantonSwap(fromAsset, toAsset, inAmount);
  const notionalUsd = await computeC2cSwapNotionalUsd({ fromAsset, inAmount });
  const readiness = await previewManagedSwapReadiness({
    userParty: user,
    fromAsset,
    toAsset,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount
  });

  await ensureProbeOffer(fromAsset);
  const offerCid = await ensureProbeOffer(fromAsset);

  const userLeg = await buildTransferExercise({
    senderParty: user,
    receiverParty: vault,
    amount: quote.inAmount,
    inputHoldings: await holdingsForSwapAsset(user, fromAsset),
    expirationSeconds: 600,
    instrumentId: await resolveSwapInstrumentId(fromAsset),
    registrarAdmin: await registrarAdminForAsset(fromAsset),
    registryKind: registryKindForAsset(fromAsset),
    assetSymbol: getSwapAsset(fromAsset).symbol,
    memo: "OranjSwap"
  });
  const deliverLeg = await buildTransferExercise({
    senderParty: vault,
    receiverParty: user,
    amount: quote.outAmount,
    inputHoldings: await holdingsForSwapAsset(vault, toAsset),
    expirationSeconds: 3600,
    instrumentId: await resolveSwapInstrumentId(toAsset),
    registrarAdmin: await registrarAdminForAsset(toAsset),
    registryKind: registryKindForAsset(toAsset),
    assetSymbol: getSwapAsset(toAsset).symbol,
    memo: "OranjSwap"
  });
  const acceptLeg = await buildAcceptExercise({
    offerContractId: offerCid,
    registrarAdmin: await registrarAdminForAsset(fromAsset),
    registryKind: registryKindForAsset(fromAsset)
  });

  const tx1Bytes = await prep(
    "offer",
    [user],
    [userLeg.command],
    userLeg.disclosedContracts,
    userLeg.synchronizerId
  );
  const acceptBytes = await prep(
    "accept",
    [user, vault],
    [acceptLeg.command],
    acceptLeg.disclosedContracts,
    deliverLeg.synchronizerId
  );
  const deliverBytes = await prep(
    "deliver",
    [user, vault],
    [deliverLeg.command],
    deliverLeg.disclosedContracts,
    deliverLeg.synchronizerId
  );
  const tx2Bytes = acceptBytes + deliverBytes;
  const totalBytes = tx1Bytes + tx2Bytes;
  const thirdTx =
    deliverLeg.transferKind.toLowerCase().includes("direct") ? null : { note: "user Accept counter offer" };

  const listUsd = (totalBytes / 1e6) * PRICE_MB;
  const platformUsd =
    notionalUsd != null ? (notionalUsd * FEE_BPS) / 10_000 : null;
  const buffered = trafficBytesToFeeCc({
    trafficBytes: totalBytes,
    extraTrafficPriceUsdPerMb: PRICE_MB,
    amuletPriceUsd: 0.162763,
    bufferBps: 1500
  });

  return {
    label,
    direction: `${fromAsset}→${toAsset}`,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    notionalUsd: notionalUsd?.toFixed(2),
    platformRevenueUsd: platformUsd?.toFixed(2),
    readiness: {
      userLegKind: readiness.userLegKind,
      counterLegKind: readiness.solverLegKind,
      counterDirect: readiness.solverLegDirect,
      issues: readiness.issues
    },
    cantonSubmits: {
      count: thirdTx ? 3 : 2,
      legs: [
        {
          n: 1,
          id: "user-offer",
          actAs: ["user"],
          commands: ["TransferFactory_Transfer → vault (offer)"],
          trafficBytes: tx1Bytes,
          listUsd: ((tx1Bytes / 1e6) * PRICE_MB).toFixed(3)
        },
        {
          n: 2,
          id: "vault-fill",
          actAs: ["user", "vault"],
          commands: [
            "TransferInstruction_Accept (user sell)",
            `TransferFactory_Transfer counter (${deliverLeg.transferKind})`,
            "+ CC network fee cmd when NETWORK_FEE_ENABLED"
          ],
          trafficBytes: tx2Bytes,
          listUsd: ((tx2Bytes / 1e6) * PRICE_MB).toFixed(3),
          breakdown: { acceptBytes, deliverBytes }
        },
        ...(thirdTx ? [{ n: 3, id: "user-accept-counter", actAs: ["user"], ...thirdTx }] : [])
      ],
      totalTrafficBytes: totalBytes,
      totalListUsd: listUsd.toFixed(3),
      totalListCc: buffered.feeCc,
      totalBufferedUsd: buffered.feeUsd.toFixed(3)
    },
    marginUsd: {
      subsidizeAllCanton: platformUsd != null ? (platformUsd - listUsd).toFixed(2) : null,
      chargeUserNetworkFeeList: platformUsd != null ? (platformUsd + listUsd - listUsd).toFixed(2) : null,
      chargeUserNetworkFeeBuffered:
        platformUsd != null ? (platformUsd + buffered.feeUsd - listUsd).toFixed(2) : null
    }
  };
}

async function main() {
  if (!vault) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY missing");
  const ccUsd = await (await import("../lib/canton-price-scan.js")).fetchAmuletPriceUsd();
  const ccSix = (6 / ccUsd).toFixed(6);
  const cc100 = (100 / ccUsd).toFixed(6);

  const scenarios = [];
  for (const row of [
    ["CBTC", "CC", "0.0001", "~$6 CBTC in"],
    ["CBTC", "CC", "0.00156384", "~$100 CBTC in"],
    ["CC", "CBTC", ccSix, "~$6 CC in"],
    ["CC", "CBTC", cc100, "~$100 CC in"]
  ] as const) {
    scenarios.push(await measureScenario(row[0], row[1], row[2], row[3]));
  }

  console.log(
    JSON.stringify(
      {
        mode: "managed-email-c2c",
        methodology:
          "WarpX devnet cannot prepare multi-command batches; tx2 bytes = accept prepare + deliver prepare (same actAs as atomic fill). Amount-independent.",
        pricing: { extraTrafficPriceUsdPerMb: PRICE_MB, ccUsd, platformFeeBps: FEE_BPS },
        userParty: user.slice(0, 32) + "…",
        vaultParty: vault.slice(0, 32) + "…",
        scenarios
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
