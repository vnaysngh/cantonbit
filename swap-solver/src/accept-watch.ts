/**
 * Accept-watch leg (Task 7b) — the Canton-side counterpart to the Base watcher.
 *
 * For orders in `delivering` (offer created, awaiting the EXTERNAL user to
 * accept), this resolves the offer:
 *   - accepted  → capture the accept tx's ledger record-time as the
 *                 authoritative fillTimestamp, mark `delivered`. (→ Task 8
 *                 attests + finalises.) If the record-time is AFTER
 *                 order.fillDeadline, the fill can no longer satisfy the order —
 *                 mark `failed` (the user accepted too late; they'll refund WBTC).
 *   - expired   → the offer lapsed unaccepted; the solver's cBTC float is
 *                 released automatically by the offer cancellation. Mark
 *                 `failed`; do NOT attest. The user refunds their WBTC.
 *   - unknown   → still pending; leave as `delivering` to re-check next tick.
 *
 * This shrinks the two-legged risk window: we only proceed to attest+finalise
 * AFTER confirming the user already holds the cBTC.
 */

import type { Hex } from "viem";

import type { CantonClient } from "./canton.js";
import type { OrderStore } from "./store.js";

export interface AcceptWatchParams {
  /** Current unix time (seconds). Injected for testability. */
  now: number;
  /** Offset to begin scanning updates from when resolving an offer. 0 = genesis
   *  (fine for low-volume; production can persist a per-order offset). */
  fromOffset: number;
}

export type AcceptOutcome =
  | { kind: "pending" }
  | { kind: "delivered"; fillTimestamp: number; recordTime: string }
  | { kind: "failed"; reason: string };

/** ISO record-time → unix seconds (uint32 domain). */
export function recordTimeToUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparseable record time: ${iso}`);
  return Math.floor(ms / 1000);
}

/**
 * Resolve one `delivering` order against the Canton ledger and transition it.
 */
export async function resolveDelivery(
  store: OrderStore,
  canton: CantonClient,
  orderId: Hex,
  params: AcceptWatchParams,
): Promise<AcceptOutcome> {
  const rec = store.get(orderId);
  if (!rec) return { kind: "failed", reason: "order not found" };
  if (rec.status !== "delivering") {
    return { kind: "pending" }; // not our concern this tick
  }
  const offerId = rec.cantonDeliveryRef;
  if (!offerId) {
    store.update(orderId, { status: "failed", note: "no offer id on a delivering order" });
    return { kind: "failed", reason: "no offer id" };
  }

  const receiver = rec.cantonParty;
  if (!receiver) {
    store.update(orderId, { status: "failed", note: "no canton party on a delivering order" });
    return { kind: "failed", reason: "no canton party" };
  }

  // Resolve the offer's outcome from the ledger.
  const resolution = await canton.resolveOffer({
    receiverParty: receiver,
    offerContractId: offerId,
    fromOffset: params.fromOffset,
  });

  if (resolution.kind === "unknown") {
    // Still active OR not yet visible. If it's still active AND the order's
    // fillDeadline has passed, the swap can no longer complete — abandon.
    const stillActive = await canton.isOfferActive(receiver, offerId).catch(() => true);
    if (stillActive && params.now > rec.order.fillDeadline) {
      store.update(orderId, {
        status: "failed",
        note: "offer still unaccepted past fillDeadline — abandoning; user will refund",
      });
      return { kind: "failed", reason: "unaccepted past fillDeadline" };
    }
    return { kind: "pending" };
  }

  if (resolution.kind === "expired") {
    store.update(orderId, {
      status: "failed",
      note: `offer expired/cancelled unaccepted (updateId=${resolution.updateId}); float released, user will refund`,
    });
    return { kind: "failed", reason: "offer expired unaccepted" };
  }

  // accepted — capture the authoritative fill timestamp.
  const fillTimestamp = recordTimeToUnixSeconds(resolution.recordTime);

  // Critical: the fill must be <= fillDeadline or the proof is invalid.
  if (fillTimestamp > rec.order.fillDeadline) {
    store.update(orderId, {
      status: "failed",
      note: `accepted too late: record-time ${fillTimestamp} > fillDeadline ${rec.order.fillDeadline}; cannot finalise, user will refund`,
    });
    return { kind: "failed", reason: "accepted after fillDeadline" };
  }

  store.update(orderId, {
    status: "delivered",
    fillTimestamp,
    note: `cBTC accepted by user at ${resolution.recordTime} (updateId=${resolution.updateId})`,
  });
  return { kind: "delivered", fillTimestamp, recordTime: resolution.recordTime };
}

/** Process all `delivering` orders once. */
export async function resolveDeliveringOrders(
  store: OrderStore,
  canton: CantonClient,
  params: AcceptWatchParams,
): Promise<{ orderId: Hex; outcome: AcceptOutcome }[]> {
  const results: { orderId: Hex; outcome: AcceptOutcome }[] = [];
  for (const rec of store.byStatus("delivering")) {
    const outcome = await resolveDelivery(store, canton, rec.orderId, params);
    results.push({ orderId: rec.orderId, outcome });
  }
  return results;
}
