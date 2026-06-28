import { extractCreatedOfferCid } from "../../../lib/mint-processor-logic";
import type { FarmAsset } from "./types";
import {
  assertSameSynchronizer,
  buildAcceptExercise,
  buildTransferExercise,
  holdingsForAsset,
  isDirectTransferKind,
  mergeDisclosed,
  registrarForAsset,
  submitLedgerCommands
} from "./ledger";
import {
  ensureVaultCbtcCacheReady,
  getVaultCbtcCachedHoldings,
  ingestVaultCbtcFromFill,
  isStaleVaultHoldingError,
  pickVaultCbtcInputsForAmount,
  removeVaultCbtcFromCache
} from "./vault-cbtc-holdings";

const USER_LEG_TTL_SECONDS = 600;
const COUNTER_LEG_TTL_SECONDS = 24 * 60 * 60;

export interface ManagedSettleParams {
  jwt: string;
  swapId: string;
  traderParty: string;
  vaultParty: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
  outAmount: string;
}

export interface ManagedSettleResult {
  offerUpdateId: string;
  fillUpdateId: string;
  userLegOfferCid: string;
  counterPendingAccept: boolean;
  counterLegOfferCid?: string;
}

async function submitUserLegOffer(params: ManagedSettleParams): Promise<{
  offerCid: string;
  offerUpdateId: string;
}> {
  const reg = await registrarForAsset(params.jwt, params.fromAsset);
  const holdings = await holdingsForAsset(
    params.jwt,
    params.traderParty,
    params.fromAsset
  );
  if (holdings.length === 0) {
    throw new Error(`trader has no ${params.fromAsset} holdings`);
  }

  const leg = await buildTransferExercise({
    jwt: params.jwt,
    senderParty: params.traderParty,
    receiverParty: params.vaultParty,
    amount: params.inAmount,
    inputHoldings: holdings,
    expirationSeconds: USER_LEG_TTL_SECONDS,
    instrumentId: reg.instrumentId,
    registrarAdmin: reg.admin,
    registryKind: reg.kind,
    assetSymbol: params.fromAsset,
    memo: "OranjSwap"
  });

  if (isDirectTransferKind(leg.transferKind)) {
    throw new Error(
      "Managed swap requires pending user sell offer — trader or vault must not auto-accept via preapproval on sell path"
    );
  }

  const commandId = `farm-swap-offer-${params.swapId}`;
  try {
    const { updateId, eventsById } = await submitLedgerCommands({
      jwt: params.jwt,
      actAs: [params.traderParty],
      commands: [leg.command],
      disclosedContracts: leg.disclosedContracts,
      commandId,
      workflowId: commandId,
      applicationId: "cbtc-farm",
      synchronizerId: leg.synchronizerId || undefined
    });
    const cid = extractCreatedOfferCid(eventsById);
    if (!cid) throw new Error("user leg offer CID missing from submit tree");
    return { offerCid: cid, offerUpdateId: updateId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate command committed")) {
      throw new Error(`user leg offer duplicate — retry with new swapId (${commandId})`);
    }
    throw e;
  }
}

async function fillFromUserOffer(params: ManagedSettleParams & {
  userLegOfferCid: string;
}): Promise<Omit<ManagedSettleResult, "offerUpdateId">> {
  const fromReg = await registrarForAsset(params.jwt, params.fromAsset);
  const toReg = await registrarForAsset(params.jwt, params.toAsset);

  const acceptLeg = await buildAcceptExercise({
    jwt: params.jwt,
    offerContractId: params.userLegOfferCid,
    registrarAdmin: fromReg.admin,
    registryKind: fromReg.kind
  });

  const commandId = `farm-swap-${params.swapId}`;
  const maxAttempts = params.toAsset === "CBTC" ? 8 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let vaultHoldings;
    if (params.toAsset === "CBTC") {
      await ensureVaultCbtcCacheReady(params.jwt, params.vaultParty);
      vaultHoldings = getVaultCbtcCachedHoldings();
    } else {
      vaultHoldings = await holdingsForAsset(
        params.jwt,
        params.vaultParty,
        params.toAsset
      );
    }
    if (vaultHoldings.length === 0) {
      throw new Error(`vault has insufficient ${params.toAsset} float`);
    }

    const deliverInputs =
      params.toAsset === "CBTC"
        ? pickVaultCbtcInputsForAmount(vaultHoldings, params.outAmount)
        : vaultHoldings;

    let deliverLeg;
    try {
      deliverLeg = await buildTransferExercise({
        jwt: params.jwt,
        senderParty: params.vaultParty,
        receiverParty: params.traderParty,
        amount: params.outAmount,
        inputHoldings: deliverInputs,
        useAllInputHoldings: params.toAsset === "CBTC",
        expirationSeconds: COUNTER_LEG_TTL_SECONDS,
        instrumentId: toReg.instrumentId,
        registrarAdmin: toReg.admin,
        registryKind: toReg.kind,
        assetSymbol: params.toAsset,
        memo: "OranjSwap"
      });

      const synchronizerId = assertSameSynchronizer([acceptLeg, deliverLeg], "fill legs");

      const { updateId, eventsById } = await submitLedgerCommands({
        jwt: params.jwt,
        actAs: [params.vaultParty],
        commands: [acceptLeg.command, deliverLeg.command],
        disclosedContracts: mergeDisclosed([
          acceptLeg.disclosedContracts,
          deliverLeg.disclosedContracts
        ]),
        commandId,
        workflowId: commandId,
        applicationId: "cbtc-farm",
        synchronizerId: synchronizerId || undefined
      });

      await ingestVaultCbtcFromFill({
        jwt: params.jwt,
        vaultParty: params.vaultParty,
        traderParty: params.traderParty,
        updateId,
        submitEventsById: eventsById
      });

      const counterLegOfferCid = extractCreatedOfferCid(eventsById) ?? undefined;
      const counterPendingAccept = Boolean(
        counterLegOfferCid && !isDirectTransferKind(deliverLeg.transferKind)
      );

      return {
        fillUpdateId: updateId,
        userLegOfferCid: params.userLegOfferCid,
        counterPendingAccept,
        counterLegOfferCid
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        params.toAsset === "CBTC" &&
        isStaleVaultHoldingError(msg) &&
        attempt < maxAttempts
      ) {
        removeVaultCbtcFromCache(deliverInputs.map((h) => h.contractId));
        console.warn(`  vault CBTC deliver retry ${attempt}: dropped stale UTXO(s)`);
        continue;
      }
      throw e;
    }
  }

  throw new Error("vault CBTC deliver exhausted UTXO retries");
}

export async function settleManagedSwap(
  params: ManagedSettleParams
): Promise<ManagedSettleResult> {
  const { offerCid, offerUpdateId } = await submitUserLegOffer(params);
  const fill = await fillFromUserOffer({ ...params, userLegOfferCid: offerCid });
  return { offerUpdateId, ...fill };
}
