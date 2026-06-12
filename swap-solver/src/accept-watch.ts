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
 *   - expired   → the offer lapsed unaccepted; the solver's CBTC float is
 *                 released automatically by the offer cancellation. Mark
 *                 `failed`; do NOT attest. The user refunds their WBTC.
 *   - unknown   → still pending; leave as `delivering` to re-check next tick.
 *
 * This shrinks the two-legged risk window: we only proceed to attest+finalise
 * AFTER confirming the user already holds the CBTC.
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
  params: AcceptWatchParams
): Promise<AcceptOutcome> {
  const rec = await store.get(orderId);
  if (!rec) return { kind: "failed", reason: "order not found" };
  if (rec.status !== "delivering") {
    return { kind: "pending" }; // not our concern this tick
  }
  const offerId = rec.cantonDeliveryRef;
  if (!offerId) {
    await store.update(orderId, {
      status: "failed",
      note: "no offer id on a delivering order"
    });
    return { kind: "failed", reason: "no offer id" };
  }

  const receiver = rec.cantonParty;
  if (!receiver) {
    await store.update(orderId, {
      status: "failed",
      note: "no canton party on a delivering order"
    });
    return { kind: "failed", reason: "no canton party" };
  }

  // CROSS-PARTICIPANT path (the mainnet case): the receiver's offer isn't readable
  // by our token (403), so we detect the accept from the SOLVER's OWN ACS — the
  // pending TransferInstruction / locked holding for our input cids disappears
  // once the user accepts (or rejects). Sender-readable, no 403. This is what lets
  // us WAIT for the accept before finalising even when we can't read the receiver.
  const cids = rec.inputHoldingCids;
  if (cids && cids.length > 0) {
    const accepted = await canton.isDeliveryAccepted(cids).catch(() => false);
    if (accepted) {
      // The pending transfer is gone → accepted (or rejected). We can't read the
      // exact accept record-time cross-participant, so use submit time bounded by
      // the deadline. If past the deadline, the float would have returned to us —
      // treat as failed so we never finalise after fillDeadline.
      if (params.now > rec.order.fillDeadline) {
        // SECURITY (HIGH-1): the CBTC WAS accepted — mark cbtcAccepted so this is
        // NEVER auto-refunded (that would give the user both legs). It can't
        // finalise (past fillDeadline → proof invalid); it needs manual review.
        await store.update(orderId, {
          status: "failed",
          cbtcAccepted: true,
          note: "accept detected but past fillDeadline — cannot finalise; MANUAL REVIEW (not refundable: CBTC delivered)"
        });
        return { kind: "failed", reason: "accepted/cleared past fillDeadline" };
      }
      const fillTimestamp = rec.fillTimestamp ?? params.now;
      await store.update(orderId, {
        status: "delivered",
        cbtcAccepted: true,
        fillTimestamp,
        note: `CBTC accept detected via solver ACS (cross-participant). updateId=${rec.cantonDeliveryRef}`
      });
      return {
        kind: "delivered",
        fillTimestamp,
        recordTime: String(fillTimestamp)
      };
    }
    // Still pending. If past the fillDeadline, the swap can't complete — abandon
    // so the user refunds (we never delivered-and-finalised one-sided).
    if (params.now > rec.order.fillDeadline) {
      await store.update(orderId, {
        status: "failed",
        note: "CBTC offer unaccepted past fillDeadline (cross-participant) — user refunds"
      });
      return { kind: "failed", reason: "unaccepted past fillDeadline (xpart)" };
    }
    return { kind: "pending" };
  }

  // READABLE-offer path (receiver on our participant): resolve via the receiver's
  // update stream. (Legacy / same-participant.)
  const resolution = await canton.resolveOffer({
    receiverParty: receiver,
    offerContractId: offerId,
    fromOffset: params.fromOffset
  });

  if (resolution.kind === "unknown") {
    // Still active OR not yet visible. If it's still active AND the order's
    // fillDeadline has passed, the swap can no longer complete — abandon.
    const stillActive = await canton
      .isOfferActive(receiver, offerId)
      .catch(() => true);
    if (stillActive && params.now > rec.order.fillDeadline) {
      await store.update(orderId, {
        status: "failed",
        note: "offer still unaccepted past fillDeadline — abandoning; user will refund"
      });
      return { kind: "failed", reason: "unaccepted past fillDeadline" };
    }
    return { kind: "pending" };
  }

  if (resolution.kind === "expired") {
    await store.update(orderId, {
      status: "failed",
      note: `offer expired/cancelled unaccepted (updateId=${resolution.updateId}); float released, user will refund`
    });
    return { kind: "failed", reason: "offer expired unaccepted" };
  }

  // accepted — capture the authoritative fill timestamp.
  const fillTimestamp = recordTimeToUnixSeconds(resolution.recordTime);

  // Critical: the fill must be <= fillDeadline or the proof is invalid.
  if (fillTimestamp > rec.order.fillDeadline) {
    // SECURITY (HIGH-1): CBTC WAS accepted (just too late to finalise). Mark
    // cbtcAccepted so it's NEVER auto-refunded; needs manual review.
    await store.update(orderId, {
      status: "failed",
      cbtcAccepted: true,
      note: `accepted too late: record-time ${fillTimestamp} > fillDeadline ${rec.order.fillDeadline}; cannot finalise — MANUAL REVIEW (not refundable: CBTC delivered)`
    });
    return { kind: "failed", reason: "accepted after fillDeadline" };
  }

  await store.update(orderId, {
    status: "delivered",
    cbtcAccepted: true,
    fillTimestamp,
    note: `CBTC accepted by user at ${resolution.recordTime} (updateId=${resolution.updateId})`
  });
  return {
    kind: "delivered",
    fillTimestamp,
    recordTime: resolution.recordTime
  };
}

/** Process all `delivering` orders once. */
export async function resolveDeliveringOrders(
  store: OrderStore,
  canton: CantonClient,
  params: AcceptWatchParams
): Promise<{ orderId: Hex; outcome: AcceptOutcome }[]> {
  const results: { orderId: Hex; outcome: AcceptOutcome }[] = [];
  for (const rec of await store.byStatus("delivering")) {
    const outcome = await resolveDelivery(store, canton, rec.orderId, params);
    results.push({ orderId: rec.orderId, outcome });
  }
  return results;
}
