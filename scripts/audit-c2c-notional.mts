#!/usr/bin/env npx tsx
/**
 * Managed C2C (email user) prepare-based fee breakdown — CBTC↔CC both directions.
 *
 *   AUDIT_USER_CANTON_PARTY=party-… bash scripts/with-env.sh devnet npx tsx scripts/audit-c2c-notional.mts
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

async function ensureProbeOfferToVault(): Promise<string> {
  const { findOfferFromSender, buildTransferExercise, submitLedgerCommands } =
    await import("../lib/transfer.js");
  const { holdingsForSwapAsset, resolveSwapInstrumentId, registrarAdminForAsset, registryKindForAsset } =
    await import("../lib/canton-swap-holdings.js");
  const { getSwapAsset } = await import("../lib/canton-assets.js");
  const { extractCreatedOfferCid } = await import("../lib/mint-processor-logic.js");

  const existing = await findOfferFromSender(user, vault);
  if (existing) return existing;

  const probeAmount = "0.00000001";
  const asset = getSwapAsset("CBTC");
  const leg = await buildTransferExercise({
    senderParty: user,
    receiverParty: vault,
    amount: probeAmount,
    inputHoldings: await holdingsForSwapAsset(user, "CBTC"),
    expirationSeconds: 3600,
    instrumentId: await resolveSwapInstrumentId("CBTC"),
    registrarAdmin: await registrarAdminForAsset("CBTC"),
    registryKind: registryKindForAsset("CBTC"),
    assetSymbol: asset.symbol,
    memo: "fee-audit-probe"
  });

  const commandId = `c2c-fee-audit-probe-${Date.now()}`;
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
  if (!cid) {
    throw new Error("Probe offer submit succeeded but no offer CID in events");
  }
  return cid;
}

async function projectPair(
  fromAsset: "CBTC" | "CC",
  toAsset: "CBTC" | "CC",
  inAmount: string,
  label: string
) {
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const {
    estimateManagedC2cSettleFee,
    computeC2cSwapNotionalUsd
  } = await import("../lib/canton-network-fee.js");
  const { buildTransferExercise } = await import("../lib/transfer.js");
  const { getSwapAsset } = await import("../lib/canton-assets.js");
  const {
    holdingsForSwapAsset,
    resolveSwapInstrumentId,
    registrarAdminForAsset,
    registryKindForAsset
  } = await import("../lib/canton-swap-holdings.js");

  const quote = await quoteMvpCantonSwap(fromAsset, toAsset, inAmount);
  const notionalUsd = await computeC2cSwapNotionalUsd({ fromAsset, inAmount });
  const estimate = await estimateManagedC2cSettleFee({
    userParty: user,
    vaultParty: vault,
    fromAsset,
    toAsset,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    includeFeeCommand: true,
    notionalUsd
  });

  const asset = getSwapAsset(toAsset);
  const deliverLeg = await buildTransferExercise({
    senderParty: vault,
    receiverParty: user,
    amount: quote.outAmount,
    inputHoldings: await holdingsForSwapAsset(vault, toAsset),
    expirationSeconds: 3600,
    instrumentId: await resolveSwapInstrumentId(toAsset),
    registrarAdmin: await registrarAdminForAsset(toAsset),
    registryKind: registryKindForAsset(toAsset),
    assetSymbol: asset.symbol,
    memo: "OranjSwap"
  });

  const tx1 = estimate.transactions?.find((t) => t.id === "c2c-user-offer");
  const tx2 = estimate.transactions?.find((t) => t.id === "c2c-vault-fill");
  const listCc = estimate.feeCc;
  const listUsdNoBuffer = estimate.feeUsd;

  const withBuffer = trafficBytesToFeeCc({
    trafficBytes: estimate.trafficBytes,
    extraTrafficPriceUsdPerMb: estimate.extraTrafficPriceUsdPerMb ?? 60,
    amuletPriceUsd: estimate.amuletPriceUsd ?? 0.165,
    bufferBps: 1500
  });

  const platformFeeApprox =
    notionalUsd != null ? (notionalUsd * quote.feeBps) / 10_000 : null;

  return {
    label,
    direction: `${fromAsset}→${toAsset}`,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    feeBps: quote.feeBps,
    notionalUsd: notionalUsd?.toFixed(2),
    platformRevenueUsdApprox: platformFeeApprox?.toFixed(2),
    counterDeliverKind: deliverLeg.transferKind,
    optionalThirdTx:
      deliverLeg.transferKind === "direct"
        ? null
        : {
            id: "user-accept-counter",
            actAs: "user",
            note: "TransferInstruction_Accept if user lacks preapproval on receive asset"
          },
    cantonSubmits: {
      count: deliverLeg.transferKind === "direct" ? 2 : 3,
      legs: [
        {
          n: 1,
          id: "c2c-user-offer",
          actAs: ["user"],
          commands: ["TransferFactory_Transfer (creates offer to vault)"],
          trafficBytes: tx1?.trafficBytes ?? 0,
          listUsd: tx1
            ? ((tx1.trafficBytes / 1e6) * (estimate.extraTrafficPriceUsdPerMb ?? 60)).toFixed(3)
            : "0"
        },
        {
          n: 2,
          id: "c2c-vault-fill",
          actAs: ["user", "vault"],
          commands: [
            "TransferInstruction_Accept (user sell offer)",
            `TransferFactory_Transfer counter (${deliverLeg.transferKind})`,
            "+ optional CC network fee to treasury when enabled"
          ],
          trafficBytes: tx2?.trafficBytes ?? 0,
          listUsd: tx2
            ? ((tx2.trafficBytes / 1e6) * (estimate.extraTrafficPriceUsdPerMb ?? 60)).toFixed(3)
            : "0"
        },
        ...(deliverLeg.transferKind === "direct"
          ? []
          : [
              {
                n: 3,
                id: "user-accept-counter",
                actAs: ["user"],
                commands: ["TransferInstruction_Accept (receive asset)"],
                trafficBytes: "estimate separately if preapproval missing",
                listUsd: "n/a"
              }
            ])
      ],
      totalTrafficBytes: estimate.trafficBytes,
      totalListUsdNoBuffer: listUsdNoBuffer.toFixed(3),
      totalListCcNoBuffer: listCc,
      totalListUsdWith15pctBuffer: withBuffer.feeUsd.toFixed(3),
      totalListCcWith15pctBuffer: withBuffer.feeCc
    },
    whoPays: {
      userActAs: "offer submit + co-sign fill (with vault)",
      vaultActAs: "fill submit (accept user leg + deliver counter)",
      nodeTraffic: "all submits on WarpX participant (user + vault parties hosted)"
    }
  };
}

async function main() {
  if (!user || !vault) {
    throw new Error("Set AUDIT_USER_CANTON_PARTY and CANTON_SWAP_SETTLEMENT_PARTY");
  }

  const ccUsd = await (await import("../lib/canton-price-scan.js")).fetchAmuletPriceUsd();
  const probeOfferCid = await ensureProbeOfferToVault();
  const cbtcSixUsd = 0.0001 * 63945;
  const ccInForSix = (cbtcSixUsd / ccUsd).toFixed(6);
  const ccInFor100 = (100 / ccUsd).toFixed(6);

  const scenarios = [];
  for (const [fromAsset, toAsset, inAmount, label] of [
    ["CBTC", "CC", "0.0001", "~$6 CBTC in"],
    ["CBTC", "CC", "0.00156384", "~$100 CBTC in"],
    ["CC", "CBTC", ccInForSix, "~$6 CC in"],
    ["CC", "CBTC", ccInFor100, "~$100 CC in"]
  ] as const) {
    scenarios.push(await projectPair(fromAsset, toAsset, inAmount, label));
  }

  console.log(
    JSON.stringify(
      {
        mode: "managed-email-c2c",
        vaultParty: vault.slice(0, 28) + "…",
        userParty: user.slice(0, 28) + "…",
        probeOfferCid: probeOfferCid.slice(0, 20) + "…",
        pricing: { ccUsd, btcUsdRef: 63945, note: "prepare list price; devnet CC burn often $0" },
        flowSummary:
          "POST /api/canton/swap/settle → submitManagedUserLegOffer + fillFromUserOffer (2 API steps, 2–3 ledger submits)",
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
