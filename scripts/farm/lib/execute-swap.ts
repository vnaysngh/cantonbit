import { randomUUID } from "node:crypto";

import { assertMainnetNetwork, assertTraderAllowlisted } from "./config";
import { auditSwapUpdatesForCcBurn } from "./burn-audit";
import { checkSwapFloat } from "./float";
import { quoteFarmSwap } from "./quote";
import { settleManagedSwap } from "./settle";
import { configureVaultCbtcCache } from "./vault-cbtc-holdings";
import type { FarmAsset, FarmFleetConfig, FarmSwapResult } from "./types";

export async function executeSwap(params: {
  jwt: string;
  fleet: FarmFleetConfig;
  traderParty: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
  outAmount?: string;
  swapId?: string;
}): Promise<FarmSwapResult> {
  assertMainnetNetwork();
  assertTraderAllowlisted(params.fleet, params.traderParty);
  configureVaultCbtcCache(params.fleet.vault);

  if (params.fromAsset === params.toAsset) {
    throw new Error("fromAsset and toAsset must differ");
  }

  const swapId = params.swapId ?? randomUUID();
  let outAmount = params.outAmount;
  if (!outAmount) {
    const q = await quoteFarmSwap({
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      inAmount: params.inAmount
    });
    outAmount = q.outAmount;
  }

  const floatOk = await checkSwapFloat({
    jwt: params.jwt,
    fleet: params.fleet,
    traderParty: params.traderParty,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    inAmount: params.inAmount,
    outAmount
  });
  if (!floatOk.ok) {
    throw new Error(floatOk.reason ?? "float check failed");
  }

  const settled = await settleManagedSwap({
    jwt: params.jwt,
    swapId,
    traderParty: params.traderParty,
    vaultParty: params.fleet.vault,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    inAmount: params.inAmount,
    outAmount
  });

  const result: FarmSwapResult = {
    swapId,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    inAmount: params.inAmount,
    outAmount,
    traderParty: params.traderParty,
    offerUpdateId: settled.offerUpdateId,
    fillUpdateId: settled.fillUpdateId,
    counterPendingAccept: settled.counterPendingAccept,
    counterLegOfferCid: settled.counterLegOfferCid
  };

  const burn = await auditSwapUpdatesForCcBurn({
    jwt: params.jwt,
    updateIds: [result.offerUpdateId, result.fillUpdateId],
    partyIds: [params.traderParty, params.fleet.vault]
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  burn audit skipped: ${msg.slice(0, 120)}`);
    return {
      ccBurnSuspected: false,
      flaggedChoices: [] as string[],
      updatesScanned: 0
    };
  });
  result.ccBurnSuspected = burn.ccBurnSuspected;
  result.burnChoices = burn.flaggedChoices;

  if (result.counterPendingAccept) {
    console.warn(
      "⚠ Counter leg pending accept — ensure trader has CC+CBTC preapproval enabled"
    );
  }

  return result;
}
