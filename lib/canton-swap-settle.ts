/**
 * Same-Canton atomic settlement via standard TransferFactory transfers.
 */
import "server-only";

import { extractLastCreatedOfferCid } from "./mint-processor-logic";
import { toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import type { CantonSwapOrder } from "./canton-swap-types";
import {
  holdingsForSwapAsset,
  registrarAdminForAsset,
  registryKindForAsset,
  resolveSwapInstrumentId
} from "./canton-swap-holdings";
import {
  isDirectTransferKind,
  previewManagedSwapReadiness
} from "./canton-swap-preapproval";
import { getSwapAsset } from "./canton-assets";
import { validateUserLegOfferSnapshot, findUserLegOfferForOrder } from "./canton-swap-offer-verify";
import {
  isLoopFillPendingCounterAccept,
  isLoopUserLegPreapprovalSettled,
  LOOP_COUNTER_OFFER_TTL_SECONDS,
  LOOP_USER_LEG_OFFER_TTL_SECONDS,
  LOOP_USER_LEG_PREAPPROVAL_SETTLED
} from "./canton-swap-order-logic";
import {
  assertSameSynchronizer,
  buildAcceptExercise,
  buildTransferExercise,
  listPendingOffers,
  mergeDisclosed,
  pickSynchronizerId,
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
    // m2m JWT cannot read external Loop parties — treat as empty, not fatal.
    if (msg.includes("(403)") || msg.includes("security-sensitive")) return [];
    throw e;
  }
}

function parseCounterOfferCid(eventsById: Record<string, unknown>): string {
  return extractLastCreatedOfferCid(eventsById) ?? "";
}

function swapAmountsMatch(
  orderAmount: string,
  holdingAmount: string,
  decimals: number
): boolean {
  try {
    return (
      toBaseUnitsFloor(holdingAmount, decimals) === toBaseUnits(orderAmount, decimals)
    );
  } catch {
    return false;
  }
}

/** Solver already received user sell via TransferPreapproval (no pending offer). */
async function detectLoopUserLegCustody(
  order: CantonSwapOrder,
  reservedCids: Set<string>
): Promise<boolean> {
  const decimals = getSwapAsset(order.fromAsset).decimals;
  const holdings = await holdingsForSwapAsset(order.solverParty, order.fromAsset);
  return holdings.some(
    (h) =>
      swapAmountsMatch(order.inAmount, h.payload.amount, decimals) &&
      !reservedCids.has(h.contractId)
  );
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

/** Managed user: both legs in one ledger submission (requires direct/auto-accept transfers). */
export async function settleManagedSwap(
  order: CantonSwapOrder
): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  const userLeg = await buildLeg({
    senderParty: order.userParty,
    receiverParty: order.solverParty,
    assetId: order.fromAsset,
    amount: order.inAmount,
    expirationSeconds: 600
  });
  const solverLeg = await buildLeg({
    senderParty: order.solverParty,
    receiverParty: order.userParty,
    assetId: order.toAsset,
    amount: order.outAmount,
    expirationSeconds: 600
  });

  if (
    !isDirectTransferKind(userLeg.transferKind) ||
    !isDirectTransferKind(solverLeg.transferKind)
  ) {
    const preview = await previewManagedSwapReadiness({
      userParty: order.userParty,
      solverParty: order.solverParty,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      inAmount: order.inAmount,
      outAmount: order.outAmount
    });
    throw new Error(
      preview.issues.length
        ? preview.issues.join(". ")
        : "Atomic swap requires auto-accept (preapproval) on both parties — enable preapproval for CBTC and CC, then retry"
    );
  }

  const synchronizerId = assertSameSynchronizer([userLeg, solverLeg], "swap legs");
  const disclosed = mergeDisclosed([
    userLeg.disclosedContracts,
    solverLeg.disclosedContracts
  ]);
  const actAs = [order.userParty, order.solverParty];
  const commandId = `canton-swap-${order.id}`;

  let eventsById: Record<string, unknown>;
  let updateId: string;
  try {
    ({ updateId, eventsById } = await submitLedgerCommands({
      actAs,
      commands: [userLeg.command, solverLeg.command],
      disclosedContracts: disclosed,
      commandId,
      workflowId: commandId,
      applicationId: "canton-swap",
      synchronizerId
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate command")) {
      return {
        updateId: order.settlementUpdateId ?? "",
        counterLegPendingAccept: false
      };
    }
    throw e;
  }

  console.log(
    `${TAG} managed settle ok order=${order.id.slice(0, 12)}… update=${updateId.slice(0, 16)}…`
  );
  return {
    updateId,
    counterLegOfferCid: parseCounterOfferCid(eventsById) || undefined,
    counterLegPendingAccept: false
  };
}

/** Loop user: solver accepts user sell leg + delivers counter in one submit. */
export async function fillLoopSwap(order: CantonSwapOrder): Promise<{
  updateId: string;
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  if (!order.userLegOfferCid) {
    throw new Error("user leg offer missing");
  }

  const deliverLeg = await buildLeg({
    senderParty: order.solverParty,
    receiverParty: order.userParty,
    assetId: order.toAsset,
    amount: order.outAmount,
    expirationSeconds: LOOP_COUNTER_OFFER_TTL_SECONDS
  });

  const preapprovalSettled = isLoopUserLegPreapprovalSettled(order.userLegOfferCid);
  let acceptLeg: Awaited<ReturnType<typeof buildAcceptExercise>> | null = null;
  if (!preapprovalSettled) {
    acceptLeg = await buildAcceptExercise({
      offerContractId: order.userLegOfferCid,
      registrarAdmin: await registrarAdminForAsset(order.fromAsset),
      registryKind: registryKindForAsset(order.fromAsset)
    });
  }

  const synchronizerId = assertSameSynchronizer(
    acceptLeg ? [acceptLeg, deliverLeg] : [deliverLeg],
    "fill legs"
  );
  const commands: unknown[] = acceptLeg
    ? [acceptLeg.command, deliverLeg.command]
    : [deliverLeg.command];
  const disclosed = mergeDisclosed(
    acceptLeg
      ? [acceptLeg.disclosedContracts, deliverLeg.disclosedContracts]
      : [deliverLeg.disclosedContracts]
  );
  const commandId = `canton-swap-fill-${order.id}`;

  let updateId: string;
  let eventsById: Record<string, unknown>;
  try {
    ({ updateId, eventsById } = await submitLedgerCommands({
      actAs: [order.solverParty],
      commands,
      disclosedContracts: disclosed,
      commandId,
      workflowId: commandId,
      applicationId: "canton-swap",
      synchronizerId
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate command")) {
      return {
        updateId: order.settlementUpdateId ?? "",
        counterLegOfferCid: order.counterLegOfferCid,
        counterLegPendingAccept: isLoopFillPendingCounterAccept(order)
      };
    }
    throw e;
  }

  const counterLegOfferCid = parseCounterOfferCid(eventsById) || undefined;
  let counterLegPendingAccept = false;
  if (counterLegOfferCid && !isDirectTransferKind(deliverLeg.transferKind)) {
    counterLegPendingAccept = true;
  }

  console.log(
    `${TAG} loop fill ok order=${order.id.slice(0, 12)}… update=${updateId.slice(0, 16)}… pendingAccept=${counterLegPendingAccept}`
  );
  return { updateId, counterLegOfferCid, counterLegPendingAccept };
}

/** Re-deliver counter asset when the prior counter offer expired (user leg already taken). */
export async function reissueLoopCounterLeg(order: CantonSwapOrder): Promise<{
  counterLegOfferCid?: string;
  counterLegPendingAccept: boolean;
}> {
  if (!order.settlementUpdateId) {
    throw new Error("solver fill not completed yet");
  }

  const deliverLeg = await buildLeg({
    senderParty: order.solverParty,
    receiverParty: order.userParty,
    assetId: order.toAsset,
    amount: order.outAmount,
    expirationSeconds: LOOP_COUNTER_OFFER_TTL_SECONDS
  });

  if (isDirectTransferKind(deliverLeg.transferKind)) {
    return { counterLegPendingAccept: false };
  }

  const commandId = `canton-swap-counter-${order.id}-${Date.now()}`;
  const { updateId, eventsById } = await submitLedgerCommands({
    actAs: [order.solverParty],
    commands: [deliverLeg.command],
    disclosedContracts: deliverLeg.disclosedContracts,
    commandId,
    workflowId: commandId,
    applicationId: "canton-swap",
    synchronizerId: deliverLeg.synchronizerId || undefined
  });

  const counterLegOfferCid = parseCounterOfferCid(eventsById) || undefined;
  console.log(
    `${TAG} counter reissue ok order=${order.id.slice(0, 12)}… update=${updateId.slice(0, 16)}… cid=${counterLegOfferCid?.slice(0, 16) ?? "direct"}…`
  );
  return { counterLegOfferCid, counterLegPendingAccept: !!counterLegOfferCid };
}

/**
 * Solver rejects a pending user→solver sell offer (receiver-only), unlocking user funds.
 */
export async function rejectUserLegOffer(order: CantonSwapOrder): Promise<void> {
  if (!order.userLegOfferCid || isLoopUserLegPreapprovalSettled(order.userLegOfferCid)) {
    return;
  }

  const pending = await listPendingOffers(order.solverParty);
  if (!pending.some((p) => p.contractId === order.userLegOfferCid)) {
    return;
  }

  await rejectTransferOffer({
    offerContractId: order.userLegOfferCid,
    actAs: [order.solverParty],
    registrarAdmin: await registrarAdminForAsset(order.fromAsset),
    registryKind: registryKindForAsset(order.fromAsset),
    commandId: `canton-swap-reject-${order.id}`
  });
  console.log(
    `${TAG} rejected user leg offer order=${order.id.slice(0, 12)}… cid=${order.userLegOfferCid.slice(0, 16)}…`
  );
}

/** Poll solver ACS for the user's sell offer after a Loop wallet submit. */
export async function resolveUserLegOfferCid(
  order: CantonSwapOrder,
  opts?: { maxAttempts?: number; pollMs?: number; reservedCids?: Set<string> }
): Promise<string> {
  const expectedInstrument = await resolveSwapInstrumentId(order.fromAsset);
  const maxAttempts = opts?.maxAttempts ?? 10;
  const pollMs = opts?.pollMs ?? 1500;
  const reservedCids = opts?.reservedCids ?? new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offers = await safeListPendingOffers(order.solverParty);
    const onSolver = findUserLegOfferForOrder(
      offers,
      order,
      expectedInstrument,
      reservedCids
    );
    if (onSolver) return onSolver;

    if (attempt === 0 && offers.length > 0) {
      console.warn(
        `${TAG} resolveUserLegOfferCid: ${offers.length} offer(s) on solver ACS but none matched order=${order.id.slice(0, 12)}… user=${order.userParty.slice(0, 24)}… amount=${order.inAmount}`
      );
    }

    if (attempt % 3 === 2 && (await detectLoopUserLegCustody(order, reservedCids))) {
      console.log(
        `${TAG} user leg auto-settled via preapproval order=${order.id.slice(0, 12)}…`
      );
      return LOOP_USER_LEG_PREAPPROVAL_SETTLED;
    }

    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  throw new Error(
    "user leg offer not visible on solver yet — wait a moment and try again"
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
    const offers = await safeListPendingOffers(order.solverParty);
    const offer = offers.find((o) => o.contractId === offerCid);
    if (offer) {
      const matched = findUserLegOfferForOrder([offer], order, expectedInstrument);
      if (matched) return;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error("user leg offer not found on solver ACS");
}

export async function prepareLoopUserLeg(order: CantonSwapOrder): Promise<{
  command: unknown;
  disclosedContracts: ReturnType<typeof mergeDisclosed>;
  synchronizerId: string;
}> {
  const instrumentId = await resolveSwapInstrumentId(order.fromAsset);
  const registrarAdmin = await registrarAdminForAsset(order.fromAsset);
  const built = await buildTransferExercise({
    senderParty: order.userParty,
    receiverParty: order.solverParty,
    amount: order.inAmount,
    inputHoldings: await holdingsForSwapAsset(order.userParty, order.fromAsset),
    expirationSeconds: LOOP_USER_LEG_OFFER_TTL_SECONDS,
    instrumentId,
    registrarAdmin,
    registryKind: registryKindForAsset(order.fromAsset),
    assetSymbol: getSwapAsset(order.fromAsset).symbol,
    memo: "OranjSwap"
  });
  return {
    command: built.command,
    disclosedContracts: built.disclosedContracts,
    synchronizerId:
      built.synchronizerId ||
      pickSynchronizerId([built.disclosedContracts])
  };
}
