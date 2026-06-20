/**
 * Same-Canton atomic settlement via standard TransferFactory transfers.
 */
import "server-only";

import { fetchTransactionTreeByCommandId, fetchTransactionTreeForOfferAccept } from "./canton-command-recovery";
import type { CantonSwapOrder } from "./canton-swap-types";
import { loopFillActAsParties, swapParty, userLegReceiverParty } from "./canton-swap-types";
import { appendNetworkFeeToFill, isNetworkFeeEnabled } from "./canton-network-fee";
import {
  holdingsForSwapAsset,
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "./canton-swap-holdings";
import {
  assertFillIncludesUserLegConsumption,
  assertOfferOnlyUserLegEvidence,
  buildLoopFillResultFromEvents,
  counterLegDeliveredToUserInEvents,
  counterOfferConsumedInEvents,
  extractCounterOfferCidFromEvents
} from "./canton-swap-leg-verify-logic";
import { verifyUserLegFromSubmitUpdate } from "./canton-swap-leg-verify";
import {
  isDirectTransferKind,
  previewLoopSwapReadiness,
  previewManagedSwapReadiness
} from "./canton-swap-preapproval";
import { getSwapAsset } from "./canton-assets";
import { findUserLegOfferForOrder } from "./canton-swap-offer-verify";
import { extractCreatedOfferCid } from "./mint-processor-logic";
import {
  isLoopFillPendingCounterAccept,
  isLoopUserLegPreapprovalSettled,
  isPendingCounterAccept,
  loopCounterReissueCommandId,
  loopFillCommandId,
  LOOP_COUNTER_OFFER_TTL_SECONDS,
  LOOP_USER_LEG_OFFER_TTL_SECONDS
} from "./canton-swap-order-logic";
import {
  assertSameSynchronizer,
  buildAcceptExercise,
  buildTransferExercise,
  listPendingOffers,
  mergeDisclosed,
  pickSynchronizerId,
  prepareTransferCommand,
  rejectTransferOffer,
  submitLedgerCommands
} from "./transfer";

const TAG = "[canton-swap-settle]";

export async function safeListPendingOffers(
  partyId: string
): Promise<Awaited<ReturnType<typeof listPendingOffers>>> {
  try {
    return await listPendingOffers(partyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("(403)") || msg.includes("security-sensitive")) return [];
    throw e;
  }
}

/** Like safeListPendingOffers but fails closed when ACS is unreadable (Loop external party). */
export async function listPendingOffersStrict(
  partyId: string
): Promise<Awaited<ReturnType<typeof listPendingOffers>>> {
  try {
    return await listPendingOffers(partyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("(403)") || msg.includes("security-sensitive")) {
      throw new Error("cannot verify pending transfers — party ACS unreadable");
    }
    throw e;
  }
}

function parseCounterOfferCid(
  eventsById: Record<string, unknown>,
  order: CantonSwapOrder
): string {
  const asset = getSwapAsset(order.toAsset);
  return (
    extractCounterOfferCidFromEvents(eventsById, {
      senderParty: swapParty(order),
      receiverParty: order.userParty,
      amount: order.outAmount,
      amountDecimals: asset.decimals
    }) ?? ""
  );
}

async function recoverCommittedFill(
  commandId: string,
  order: CantonSwapOrder,
  deliverTransferKind: string
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  const recovered = await fetchTransactionTreeByCommandId(
    commandId,
    swapParty(order)
  );
  if (!recovered?.updateId) {
    throw new Error(
      `duplicate command committed but fill transaction not found (${commandId})`
    );
  }
  return buildLoopFillResultFromEvents(
    order,
    recovered.updateId,
    recovered.eventsById,
    deliverTransferKind
  );
}

async function isPendingUserLegOffer(
  order: CantonSwapOrder,
  cid: string
): Promise<boolean> {
  if (isLoopUserLegPreapprovalSettled(cid)) return false;
  const receiver = userLegReceiverParty(order);
  const pending = await safeListPendingOffers(receiver);
  return pending.some((p) => p.contractId === cid);
}

async function buildLeg(params: {
  senderParty: string;
  receiverParty: string;
  assetId: CantonSwapOrder["fromAsset"] | CantonSwapOrder["toAsset"];
  amount: string;
  expirationSeconds?: number;
}) {
  const asset = getSwapAsset(params.assetId);
  const holdings = await holdingsForSwapAsset(params.senderParty, params.assetId);
  const instrumentId = await resolveSwapInstrumentId(params.assetId);
  const registrarAdmin = await registrarAdminForAsset(params.assetId);
  return buildTransferExercise({
    senderParty: params.senderParty,
    receiverParty: params.receiverParty,
    amount: params.amount,
    inputHoldings: holdings,
    expirationSeconds: params.expirationSeconds,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(params.assetId),
    assetSymbol: asset.symbol,
    memo: "OranjSwap"
  });
}

/** Managed user: backend offer to vault, then vault fill (Accept + counter). */
async function submitManagedUserLegOffer(order: CantonSwapOrder): Promise<{
  userLegOfferCid: string;
}> {
  const vault = swapParty(order);
  const userLeg = await buildLeg({
    senderParty: order.userParty,
    receiverParty: vault,
    assetId: order.fromAsset,
    amount: order.inAmount,
    expirationSeconds: 600
  });

  if (isDirectTransferKind(userLeg.transferKind)) {
    const preview = await previewManagedSwapReadiness({
      userParty: order.userParty,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      inAmount: order.inAmount,
      outAmount: order.outAmount
    });
    throw new Error(
      preview.issues.length
        ? preview.issues.join(". ")
        : "Managed swap requires pending user sell offer to vault — settlement receiver must not have TransferPreapproval"
    );
  }

  let commands: unknown[] = [userLeg.command];
  let disclosed = userLeg.disclosedContracts;

  const commandId = `canton-swap-offer-${order.id}`;
  try {
    const { eventsById } = await submitLedgerCommands({
      actAs: [order.userParty],
      commands,
      disclosedContracts: disclosed,
      commandId,
      workflowId: commandId,
      applicationId: "canton-swap",
      synchronizerId: userLeg.synchronizerId || undefined
    });
    const cid = extractCreatedOfferCid(eventsById);
    if (cid) return { userLegOfferCid: cid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("duplicate command committed") ||
      msg.includes("submission in flight")
    ) {
      const expectedInstrument = await resolveSwapInstrumentId(order.fromAsset);
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        const offers = await safeListPendingOffers(vault);
        const matched = findUserLegOfferForOrder(offers, order, expectedInstrument);
        if (matched) return { userLegOfferCid: matched };
        if (msg.includes("duplicate command committed")) {
          const recovered = await fetchTransactionTreeByCommandId(
            commandId,
            order.userParty
          );
          const cid = recovered?.eventsById
            ? extractCreatedOfferCid(recovered.eventsById)
            : null;
          if (cid) return { userLegOfferCid: cid };
        }
      }
      if (msg.includes("submission in flight")) {
        throw new Error(
          `user leg offer still in flight (${commandId}) — retry shortly`
        );
      }
    }
    if (msg.includes("submission in flight")) throw e;
    throw e;
  }

  const resolved = await resolveUserLegEvidence(order, { maxAttempts: 8, pollMs: 1000 });
  return {
    userLegOfferCid: resolved.userLegOfferCid
  };
}

async function fillFromUserOffer(
  order: CantonSwapOrder,
  userLegOfferCid: string,
  commandId: string
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
  networkFeeCollected?: import("./canton-network-fee").NetworkFeeCollection;
}> {
  const pendingOffer = await isPendingUserLegOffer(order, userLegOfferCid);
  if (!pendingOffer) {
    throw new Error(
      "user leg pending offer not found on settlement vault — cannot fill atomically"
    );
  }

  const acceptLeg = await buildAcceptExercise({
    offerContractId: userLegOfferCid,
    registrarAdmin: await registrarAdminForAsset(order.fromAsset),
    registryKind: registryKindForAsset(order.fromAsset)
  });

  const deliverLeg = await buildLeg({
    senderParty: swapParty(order),
    receiverParty: order.userParty,
    assetId: order.toAsset,
    amount: order.outAmount,
    expirationSeconds: LOOP_COUNTER_OFFER_TTL_SECONDS
  });

  assertFillIncludesUserLegConsumption({
    userLegOfferCid,
    acceptLegIncluded: true,
    isPendingOffer: true
  });

  let commands: unknown[] = [acceptLeg.command, deliverLeg.command];
  let disclosed = mergeDisclosed([
    acceptLeg.disclosedContracts,
    deliverLeg.disclosedContracts
  ]);
  let actAs = loopFillActAsParties(order);
  let networkFeeCollected:
    | import("./canton-network-fee").NetworkFeeCollection
    | undefined;

  if (
    order.walletMode === "managed" &&
    order.networkFeeCc &&
    isNetworkFeeEnabled()
  ) {
    const feeBundle = await appendNetworkFeeToFill({
      order,
      networkFeeCc: order.networkFeeCc,
      acceptLeg,
      deliverLeg
    });
    if (feeBundle) {
      commands = feeBundle.commands;
      disclosed = feeBundle.disclosed;
      actAs = feeBundle.actAs;
      networkFeeCollected = { feeCc: order.networkFeeCc };
    }
  }

  const synchronizerId = assertSameSynchronizer([acceptLeg, deliverLeg], "fill legs");

  let updateId: string;
  let eventsById: Record<string, unknown>;
  try {
    ({ updateId, eventsById } = await submitLedgerCommands({
      actAs,
      commands,
      disclosedContracts: disclosed,
      commandId,
      workflowId: commandId,
      applicationId: "canton-swap",
      synchronizerId
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate command committed")) {
      return recoverCommittedFill(commandId, order, deliverLeg.transferKind);
    }
    if (msg.includes("submission in flight")) throw e;
    throw e;
  }

  return {
    ...buildLoopFillResultFromEvents(
      order,
      updateId,
      eventsById,
      deliverLeg.transferKind
    ),
    networkFeeCollected
  };
}

export async function settleManagedSwap(
  order: CantonSwapOrder
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
  networkFeeCollected?: import("./canton-network-fee").NetworkFeeCollection;
}> {
  const { userLegOfferCid } = await submitManagedUserLegOffer(order);
  const commandId = `canton-swap-${order.id}`;
  const result = await fillFromUserOffer(order, userLegOfferCid, commandId);
  console.log(
    `${TAG} managed settle ok order=${order.id.slice(0, 12)}… update=${result.updateId.slice(0, 16)}…`
  );
  return result;
}

async function buildFillRecoveryFromEvents(
  order: CantonSwapOrder,
  updateId: string,
  eventsById: Record<string, unknown>
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  const asset = getSwapAsset(order.toAsset);
  const expectedInstrument = await resolveSwapInstrumentId(order.toAsset);
  const counterLegOfferCid =
    extractCounterOfferCidFromEvents(eventsById, {
      senderParty: swapParty(order),
      receiverParty: order.userParty,
      amount: order.outAmount,
      amountDecimals: asset.decimals
    }) ?? undefined;
  const directDelivered = counterLegDeliveredToUserInEvents(eventsById, {
    senderParty: swapParty(order),
    receiverParty: order.userParty,
    amount: order.outAmount,
    amountDecimals: asset.decimals,
    expectedInstrument
  });
  const deliverKind =
    counterLegOfferCid || !directDelivered ? "offer" : "direct";
  return buildLoopFillResultFromEvents(
    order,
    updateId,
    eventsById,
    deliverKind
  );
}

/** Recover managed fill from committed ledger when DB lost the outcome (race / in-flight). */
export async function repairManagedFillFromLedger(
  order: CantonSwapOrder
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
} | null> {
  const commandId = `canton-swap-${order.id}`;
  const recovered = await fetchTransactionTreeByCommandId(
    commandId,
    swapParty(order),
    50_000
  );
  if (!recovered?.updateId) return null;
  return buildFillRecoveryFromEvents(
    order,
    recovered.updateId,
    recovered.eventsById
  );
}

/** Recover Loop fill from committed ledger when DB lost the outcome (race / in-flight). */
export async function repairLoopFillFromLedger(
  order: CantonSwapOrder
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
} | null> {
  const commandId = loopFillCommandId(order.id);
  const recovered = await fetchTransactionTreeByCommandId(
    commandId,
    swapParty(order),
    50_000
  );
  if (!recovered?.updateId) return null;
  return buildFillRecoveryFromEvents(
    order,
    recovered.updateId,
    recovered.eventsById
  );
}

/** Loop user: vault accepts user sell leg + delivers counter in one submit. */
export async function fillLoopSwap(order: CantonSwapOrder): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  if (!order.userLegOfferCid) {
    throw new Error("user leg offer missing");
  }
  if (isLoopUserLegPreapprovalSettled(order.userLegOfferCid)) {
    throw new Error("legacy preapproval sentinel — reconfirm user leg");
  }

  const commandId = loopFillCommandId(order.id);
  return fillFromUserOffer(order, order.userLegOfferCid, commandId);
}

async function recoverCommittedCounterReissue(
  commandId: string,
  order: CantonSwapOrder,
  deliverTransferKind: string
): Promise<{
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
  counterReissueAttempt: number;
}> {
  const recovered = await fetchTransactionTreeByCommandId(
    commandId,
    swapParty(order),
    50_000
  );
  if (!recovered?.eventsById) {
    throw new Error(
      `duplicate command committed but counter reissue not found (${commandId})`
    );
  }
  const attempt = (order.counterReissueAttempt ?? 0) + 1;
  const expectedInstrument = await resolveSwapInstrumentId(order.toAsset);
  const asset = getSwapAsset(order.toAsset);
  const counterLegOfferCid = parseCounterOfferCid(recovered.eventsById, order) || undefined;
  const counterLegPendingAccept = Boolean(
    counterLegOfferCid && !isDirectTransferKind(deliverTransferKind)
  );
  if (isDirectTransferKind(deliverTransferKind)) {
    if (
      !counterLegDeliveredToUserInEvents(recovered.eventsById, {
        senderParty: swapParty(order),
        receiverParty: order.userParty,
        amount: order.outAmount,
        amountDecimals: asset.decimals,
        expectedInstrument
      })
    ) {
      throw new Error("counter reissue direct transfer did not deliver to user");
    }
    return { counterLegPendingAccept: false, counterReissueAttempt: attempt };
  }
  if (!counterLegOfferCid) {
    throw new Error("counter reissue did not create pending offer");
  }
  return { counterLegOfferCid, counterLegPendingAccept: true, counterReissueAttempt: attempt };
}

/** Re-deliver counter asset when the prior counter offer expired (user sell leg already taken). */
export async function reissueLoopCounterLeg(order: CantonSwapOrder): Promise<{
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
  counterReissueAttempt: number;
}> {
  if (!order.settlementUpdateId) {
    throw new Error("solver fill not completed yet");
  }

  const deliverLeg = await buildLeg({
    senderParty: swapParty(order),
    receiverParty: order.userParty,
    assetId: order.toAsset,
    amount: order.outAmount,
    expirationSeconds: LOOP_COUNTER_OFFER_TTL_SECONDS
  });

  const attempt = (order.counterReissueAttempt ?? 0) + 1;
  const commandId = loopCounterReissueCommandId(order.id, attempt);
  const expectedInstrument = await resolveSwapInstrumentId(order.toAsset);
  const asset = getSwapAsset(order.toAsset);

  let eventsById: Record<string, unknown>;
  try {
    ({ eventsById } = await submitLedgerCommands({
      actAs: [swapParty(order)],
      commands: [deliverLeg.command],
      disclosedContracts: deliverLeg.disclosedContracts,
      commandId,
      workflowId: commandId,
      applicationId: "canton-swap",
      synchronizerId: deliverLeg.synchronizerId || undefined
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate command committed")) {
      return recoverCommittedCounterReissue(commandId, order, deliverLeg.transferKind);
    }
    if (msg.includes("submission in flight")) throw e;
    throw e;
  }

  const counterLegOfferCid = parseCounterOfferCid(eventsById, order) || undefined;
  const counterLegPendingAccept = Boolean(
    counterLegOfferCid && !isDirectTransferKind(deliverLeg.transferKind)
  );

  if (isDirectTransferKind(deliverLeg.transferKind)) {
    if (
      !counterLegDeliveredToUserInEvents(eventsById, {
        senderParty: swapParty(order),
        receiverParty: order.userParty,
        amount: order.outAmount,
        amountDecimals: asset.decimals,
        expectedInstrument
      })
    ) {
      throw new Error("counter reissue direct transfer did not deliver to user");
    }
    console.log(
      `${TAG} counter reissue direct ok order=${order.id.slice(0, 12)}… attempt=${attempt}`
    );
    return { counterLegPendingAccept: false, counterReissueAttempt: attempt };
  }

  if (!counterLegOfferCid) {
    throw new Error("counter reissue did not create pending offer");
  }
  console.log(
    `${TAG} counter reissue ok order=${order.id.slice(0, 12)}… attempt=${attempt} cid=${counterLegOfferCid.slice(0, 16)}…`
  );
  return { counterLegOfferCid, counterLegPendingAccept: true, counterReissueAttempt: attempt };
}

/**
 * Solver rejects a pending user→solver sell offer (receiver-only), unlocking user funds.
 */
export async function rejectUserLegOffer(order: CantonSwapOrder): Promise<void> {
  if (
    !order.userLegOfferCid ||
    isLoopUserLegPreapprovalSettled(order.userLegOfferCid)
  ) {
    return;
  }

  const receiver = userLegReceiverParty(order);
  const pending = await listPendingOffers(receiver);
  if (!pending.some((p) => p.contractId === order.userLegOfferCid)) {
    return;
  }

  await rejectTransferOffer({
    offerContractId: order.userLegOfferCid,
    actAs: [receiver],
    registrarAdmin: await registrarAdminForAsset(order.fromAsset),
    registryKind: registryKindForAsset(order.fromAsset),
    commandId: `canton-swap-reject-${order.id}`
  });
  console.log(
    `${TAG} rejected user leg offer order=${order.id.slice(0, 12)}… cid=${order.userLegOfferCid.slice(0, 16)}…`
  );
}

export interface ResolveUserLegResult {
  userLegOfferCid: string;
  userLegSubmitUpdateId?: string;
}

/** Poll settlement receiver ACS for the user's sell offer after a Loop wallet submit. */
export async function resolveUserLegEvidence(
  order: CantonSwapOrder,
  opts?: {
    maxAttempts?: number;
    pollMs?: number;
    reservedCids?: Set<string>;
    offerCidHint?: string;
    submitUpdateId?: string;
  }
): Promise<ResolveUserLegResult> {
  const expectedInstrument = await resolveSwapInstrumentId(order.fromAsset);
  const receiver = userLegReceiverParty(order);
  const maxAttempts = opts?.maxAttempts ?? 10;
  const pollMs = opts?.pollMs ?? 1500;
  const reservedCids = opts?.reservedCids ?? new Set<string>();

  if (opts?.submitUpdateId) {
    try {
      const evidence = await verifyUserLegFromSubmitUpdate(opts.submitUpdateId, {
        userParty: order.userParty,
        solverParty: receiver,
        inAmount: order.inAmount,
        fromAsset: order.fromAsset,
        expectedInstrument
      });
      assertOfferOnlyUserLegEvidence(evidence);
      if (reservedCids.has(evidence.offerCid!)) {
        throw new Error("user leg offer already reserved by another order");
      }
      return {
        userLegOfferCid: evidence.offerCid!,
        userLegSubmitUpdateId: opts.submitUpdateId
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("already reserved by another order") ||
        msg.includes("preapproval auto-accept") ||
        msg.includes("does not prove pending offer")
      ) {
        throw e;
      }
      console.warn(
        `${TAG} submitUpdateId proof unavailable order=${order.id.slice(0, 12)}…: ${msg} — falling back to ACS`
      );
    }
  }

  const hint = opts?.offerCidHint?.trim();
  if (hint) {
    for (let attempt = 0; attempt < Math.min(maxAttempts, 5); attempt++) {
      try {
        await verifyUserLegOffer(order, hint, { maxAttempts: 1, pollMs: 0 });
        if (reservedCids.has(hint)) {
          throw new Error("user leg offer already reserved by another order");
        }
        return { userLegOfferCid: hint, userLegSubmitUpdateId: opts?.submitUpdateId };
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offers = await safeListPendingOffers(receiver);
    const onReceiver = findUserLegOfferForOrder(
      offers,
      order,
      expectedInstrument,
      reservedCids
    );
    if (onReceiver) {
      return {
        userLegOfferCid: onReceiver,
        userLegSubmitUpdateId: opts?.submitUpdateId
      };
    }

    if (attempt === 0 && offers.length > 0) {
      console.warn(
        `${TAG} resolveUserLegEvidence: ${offers.length} offer(s) on settlement ACS but none matched order=${order.id.slice(0, 12)}…`
      );
    }

    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  throw new Error(
    "user leg offer not visible on settlement receiver yet — wait a moment and try again"
  );
}

/** Verify a pending offer matches the order's user sell leg. */
export async function verifyUserLegOffer(
  order: CantonSwapOrder,
  offerCid: string,
  opts?: { maxAttempts?: number; pollMs?: number }
): Promise<void> {
  const expectedInstrument = await resolveSwapInstrumentId(order.fromAsset);
  const maxAttempts = opts?.maxAttempts ?? 5;
  const pollMs = opts?.pollMs ?? 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offers = await safeListPendingOffers(userLegReceiverParty(order));
    const offer = offers.find((o) => o.contractId === offerCid);
    if (offer) {
      const matched = findUserLegOfferForOrder([offer], order, expectedInstrument);
      if (matched) return;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error("user leg offer not found on settlement receiver ACS");
}

export type CounterLegReceiptStatus = "received" | "pending" | "not_received";

/** Poll user ACS + ledger Accept scan before declaring counter unreceived. */
export async function verifyCounterLegReceipt(
  order: CantonSwapOrder,
  opts?: { maxAttempts?: number; pollMs?: number; lookback?: number }
): Promise<CounterLegReceiptStatus> {
  if (!order.settlementUpdateId) return "not_received";
  if (!isPendingCounterAccept(order)) return "received";
  if (!order.counterLegOfferCid) return "not_received";

  const maxAttempts = opts?.maxAttempts ?? 3;
  const pollMs = opts?.pollMs ?? 1000;
  const lookback = opts?.lookback ?? 50_000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pending = await safeListPendingOffers(order.userParty);
    if (pending.some((p) => p.contractId === order.counterLegOfferCid)) {
      return "pending";
    }

    const acceptTx = await fetchTransactionTreeForOfferAccept(
      order.counterLegOfferCid,
      order.userParty,
      counterOfferConsumedInEvents,
      lookback
    );
    if (acceptTx) return "received";

    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  return "not_received";
}

/** True when user received counter asset from this swap's counter leg. */
export async function userReceivedCounterLeg(order: CantonSwapOrder): Promise<boolean> {
  return (await verifyCounterLegReceipt(order)) === "received";
}

export { previewLoopSwapReadiness };

export async function prepareLoopUserLeg(order: CantonSwapOrder): Promise<{
  command: unknown;
  disclosedContracts: ReturnType<typeof mergeDisclosed>;
  synchronizerId: string;
  transferKind: string;
  counterRequiresAccept: boolean;
}> {
  const receiver = userLegReceiverParty(order);
  const instrumentId = await resolveSwapInstrumentId(order.fromAsset);
  const registrarAdmin = await registrarAdminForAsset(order.fromAsset);
  const built = await buildTransferExercise({
    senderParty: order.userParty,
    receiverParty: receiver,
    amount: order.inAmount,
    inputHoldings: await holdingsForSwapAsset(order.userParty, order.fromAsset),
    expirationSeconds: LOOP_USER_LEG_OFFER_TTL_SECONDS,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(order.fromAsset),
    assetSymbol: getSwapAsset(order.fromAsset).symbol,
    memo: "OranjSwap"
  });

  if (isDirectTransferKind(built.transferKind)) {
    const preview = await previewLoopSwapReadiness({
      userParty: order.userParty,
      settlementParty: order.settlementParty,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      inAmount: order.inAmount,
      outAmount: order.outAmount
    });
    throw new Error(
      preview.issues[0] ??
        "Swap requires pending transfer offer — settlement receiver must not have TransferPreapproval"
    );
  }

  const counterPreview = await previewLoopSwapReadiness({
    userParty: order.userParty,
    settlementParty: order.settlementParty,
    fromAsset: order.fromAsset,
    toAsset: order.toAsset,
    inAmount: order.inAmount,
    outAmount: order.outAmount
  });

  return {
    command: built.command,
    disclosedContracts: built.disclosedContracts,
    synchronizerId:
      built.synchronizerId ||
      pickSynchronizerId([built.disclosedContracts]),
    transferKind: built.transferKind,
    counterRequiresAccept: counterPreview.counterRequiresAccept
  };
}

/** Loop user leg when holding cids come from the Loop wallet (server cannot read Loop ACS). */
export async function prepareLoopUserLegWithCids(
  order: CantonSwapOrder,
  inputHoldingCids: string[]
): Promise<{
  command: unknown;
  disclosedContracts: ReturnType<typeof mergeDisclosed>;
  synchronizerId: string;
  transferKind: string;
  counterRequiresAccept: boolean;
}> {
  if (!inputHoldingCids.length) {
    throw new Error("inputHoldingCids required for Loop user leg");
  }
  const receiver = userLegReceiverParty(order);
  const instrumentId = await resolveSwapInstrumentId(order.fromAsset);
  const registrarAdmin = await registrarAdminForAsset(order.fromAsset);
  const prepared = await prepareTransferCommand({
    senderParty: order.userParty,
    receiverParty: receiver,
    amountBtc: order.inAmount,
    inputHoldingCids,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(order.fromAsset),
    expirationSeconds: LOOP_USER_LEG_OFFER_TTL_SECONDS
  });

  if (isDirectTransferKind(prepared.transferKind)) {
    const preview = await previewLoopSwapReadiness({
      userParty: order.userParty,
      settlementParty: order.settlementParty,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      inAmount: order.inAmount,
      outAmount: order.outAmount
    });
    throw new Error(
      preview.issues[0] ??
        "Swap requires pending transfer offer — settlement receiver must not have TransferPreapproval"
    );
  }

  const counterPreview = await previewLoopSwapReadiness({
    userParty: order.userParty,
    settlementParty: order.settlementParty,
    fromAsset: order.fromAsset,
    toAsset: order.toAsset,
    inAmount: order.inAmount,
    outAmount: order.outAmount
  });

  return {
    command: prepared.command,
    disclosedContracts: prepared.disclosedContracts,
    synchronizerId: prepared.synchronizerId,
    transferKind: prepared.transferKind,
    counterRequiresAccept: counterPreview.counterRequiresAccept
  };
}
