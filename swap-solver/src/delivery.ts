/**
 * Delivery leg (Task 7a) — create the cBTC offer for a `seen` order.
 *
 * For each order: run the two-legged ordering GUARD, check the solver's cBTC
 * float, then create the transfer offer (solver float → user's Canton party)
 * and mark the order `delivering`. It does NOT wait for the external user to
 * accept — that's Task 7b, which captures the fill timestamp and marks
 * `delivered`.
 *
 * Ordering guard rationale: in two-legged settlement the solver bears the
 * completion risk. We only put cBTC into an offer once the Base lock is final
 * and there is enough time left to (a) let the user accept and (b) attest +
 * finalise before fillDeadline. If not, we skip rather than risk a delivery we
 * can't get paid for.
 */

import { formatUnits, type Hex } from "viem";

import { CantonClient, InsufficientFloatError, btcStringToSats } from "./canton.js";
import { verifyCantonParty } from "./order.js";
import type { OrderStore, OrderRecord } from "./store.js";

export interface DeliveryParams {
  /** Min seconds that must remain before fillDeadline to start a delivery.
   *  Covers user-accept latency + attest + finalise. */
  minSecondsBeforeDeadline: number;
  /** Current unix time (seconds). Injected for testability. */
  now: number;
  /** cBTC decimals for converting the on-chain amount to a BTC string. */
  cbtcDecimals: number;
}

export type DeliveryOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "delivering"; offerContractId: string; updateId: string }
  // Wallet auto-accepted the offer on creation → collapsed to delivered in one
  // step (no separate accept to watch). fillTimestamp = submit time.
  | { kind: "delivered"; updateId: string; fillTimestamp: number }
  | { kind: "failed"; reason: string };

/**
 * Attempt to start delivery for one order. Pure orchestration: reads the order
 * from the store, applies the guard + float check, creates the offer, and
 * transitions the store record. Returns the outcome (also reflected in store).
 */
export async function startDelivery(
  store: OrderStore,
  canton: CantonClient,
  orderId: Hex,
  params: DeliveryParams,
): Promise<DeliveryOutcome> {
  const rec = store.get(orderId);
  if (!rec) return { kind: "failed", reason: "order not found in store" };
  if (rec.status !== "seen") {
    return { kind: "skipped", reason: `status is '${rec.status}', not 'seen'` };
  }

  const out = rec.order.outputs[0];
  if (!out) return fail(store, orderId, "order has no output");

  // --- GUARD 1: time. Must have margin before fillDeadline. ---
  const secondsLeft = rec.order.fillDeadline - params.now;
  if (secondsLeft < params.minSecondsBeforeDeadline) {
    return { kind: "skipped", reason: `only ${secondsLeft}s before fillDeadline (need >= ${params.minSecondsBeforeDeadline}s)` };
  }

  // The cBTC amount to deliver, as a BTC string (the transfer API speaks BTC).
  const amountBtc = formatUnits(BigInt(out.amount), params.cbtcDecimals);

  // The full Canton party the solver must deliver to. The order only commits to
  // keccak256(party) (output.recipient); the preimage is supplied off-chain and
  // stored on the record. Refuse to deliver if we don't have a party...
  const cantonParty = rec.cantonParty;
  if (!cantonParty) {
    return { kind: "skipped", reason: "no Canton party preimage yet (awaiting off-chain request match)" };
  }
  // ...and SECURITY-CRITICAL: the preimage must hash to the committed recipient.
  // Otherwise a wrong/malicious party could redirect the cBTC.
  if (!verifyCantonParty(cantonParty, out.recipient)) {
    return fail(store, orderId, "Canton party does not match the on-chain recipient commitment — refusing to deliver");
  }

  // --- GUARD 2: float. Refuse rather than half-deliver. ---
  let floatSats: bigint;
  try {
    floatSats = await canton.getFloatSats();
  } catch (e) {
    return { kind: "skipped", reason: `float check failed (transient): ${errMsg(e)}` };
  }
  const needSats = btcStringToSats(amountBtc);
  if (floatSats < needSats) {
    return fail(store, orderId, `insufficient cBTC float: have ${floatSats} sats, need ${needSats} sats`);
  }

  // --- Create the offer (Phase 1). ---
  try {
    const holdings = await canton.getHoldings(canton.solverParty);
    const { updateId, offerContractId, autoAccepted } = await canton.createOffer({
      receiverParty: cantonParty,
      amountBtc,
      inputHoldings: holdings,
    });

    // If the receiver wallet auto-accepts, the offer is consumed on creation —
    // there is no offerContractId to watch and no separate accept event. The
    // delivery is already final, so collapse straight to `delivered` using the
    // submit time as the fill timestamp. (Mirrors e2e-full.ts.)
    if (autoAccepted || !offerContractId) {
      store.update(orderId, {
        status: "delivered",
        cantonDeliveryRef: updateId,
        fillTimestamp: params.now,
        note: `auto-accepted on delivery (updateId=${updateId})`,
      });
      return { kind: "delivered", updateId, fillTimestamp: params.now };
    }

    store.update(orderId, {
      status: "delivering",
      cantonDeliveryRef: offerContractId,
      note: `offer created (updateId=${updateId})`,
    });
    return { kind: "delivering", offerContractId, updateId };
  } catch (e) {
    if (e instanceof InsufficientFloatError) {
      return fail(store, orderId, e.message);
    }
    // Transient submit/registry error — leave as 'seen' so it retries.
    return { kind: "skipped", reason: `offer creation failed (will retry): ${errMsg(e)}` };
  }
}

function fail(store: OrderStore, orderId: Hex, reason: string): DeliveryOutcome {
  store.update(orderId, { status: "failed", note: reason });
  return { kind: "failed", reason };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Convenience: process all `seen` orders once. */
export async function deliverSeenOrders(
  store: OrderStore,
  canton: CantonClient,
  params: DeliveryParams,
): Promise<{ order: OrderRecord; outcome: DeliveryOutcome }[]> {
  const results: { order: OrderRecord; outcome: DeliveryOutcome }[] = [];
  for (const rec of store.byStatus("seen")) {
    const outcome = await startDelivery(store, canton, rec.orderId, params);
    results.push({ order: rec, outcome });
  }
  return results;
}
