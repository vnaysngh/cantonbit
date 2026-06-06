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
  /**
   * C3 — optional hard ceiling on TOTAL cBTC value in-flight (sats), summed over
   * orders that are delivering/delivered but not yet finalised/refunded. 0 or
   * undefined = no extra cap. This is DEFENSE IN DEPTH: the float bound +
   * per-order cap + locked-float exclusion already prevent over-delivery; this
   * caps the blast radius of any unforeseen accounting error to a known limit.
   */
  maxInflightSats?: bigint;
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

  // --- GUARD 3 (C3): total in-flight exposure cap (defense in depth). Sum the
  // cBTC value of orders already delivering/delivered (not yet finalised); if
  // adding this one would exceed the configured ceiling, skip until something
  // settles. Bounds the blast radius of any accounting error to a known limit. ---
  if (params.maxInflightSats && params.maxInflightSats > 0n) {
    let inflight = 0n;
    for (const r of [...store.byStatus("delivering"), ...store.byStatus("delivered")]) {
      const o = r.order.outputs[0];
      if (o) inflight += BigInt(o.amount);
    }
    if (inflight + needSats > params.maxInflightSats) {
      return { kind: "skipped", reason: `in-flight cap: ${inflight}+${needSats} > ${params.maxInflightSats} sats — waiting for settlement` };
    }
  }

  // --- CONCURRENCY CLAIM (C4): atomically transition seen → delivering BEFORE
  // the async createOffer. If a racing caller (API + watch loop, or two ticks)
  // already claimed it, this returns false and we skip — preventing the same
  // order from being delivered twice (double-spending the float). The status
  // guard at the top of this function is NOT sufficient alone because of the
  // await gap between it and the first status write; the claim closes that gap. ---
  const won = store.claimStatus(orderId, "seen", "delivering", {
    note: "claimed for delivery",
  });
  if (!won) {
    return { kind: "skipped", reason: "another worker already claimed this order (concurrency guard)" };
  }

  // --- Create the offer (Phase 1). ---
  try {
    const holdings = await canton.getHoldings(canton.solverParty);
    const { updateId, offerContractId, autoAccepted } = await canton.createOffer({
      receiverParty: cantonParty,
      amountBtc,
      inputHoldings: holdings,
    });

    // Two cases collapse straight to `delivered` (we don't wait for a separate
    // accept event we can observe):
    //
    //  (a) autoAccepted — the receiver wallet auto-accepted; the offer was
    //      consumed on creation. Delivery is final.
    //  (b) offer created but we CAN'T track the accept (offerContractId == "")
    //      — the receiver is on another participant our token can't read. By
    //      design we DON'T try to detect the cross-participant accept; the cBTC
    //      transfer offer has been SENT from our float, and the user accepts it
    //      in their own wallet. We treat delivery as done and finalise; the note
    //      tells the user to check their wallet.
    //
    // fillTimestamp = submit time (the offer's creation record-time on our side).
    if (autoAccepted || !offerContractId) {
      const note = autoAccepted
        ? `auto-accepted on delivery (updateId=${updateId})`
        : `cBTC transfer SENT to the recipient — they must accept it in their wallet ` +
          `(auto-accept off). updateId=${updateId}`;
      store.update(orderId, {
        status: "delivered",
        cantonDeliveryRef: updateId,
        fillTimestamp: params.now,
        note,
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
    // Transient submit/registry error — RELEASE the delivery claim (delivering →
    // seen) so a later tick retries. Without this rollback the order would be
    // stuck in `delivering` forever (we claimed it, then the offer failed). The
    // createOffer either fully succeeded (we'd have returned above) or fully
    // failed here, so it's safe to revert to seen and retry cleanly.
    store.claimStatus(orderId, "delivering", "seen", {
      note: `offer creation failed, released for retry: ${errMsg(e)}`,
    });
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
