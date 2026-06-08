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
  /**
   * PRE-FLIGHT: verify the WBTC collection is GUARANTEED before we deliver the
   * cBTC, so the two legs pass-or-fail together (never user-gets-cBTC-but-we-
   * lose-WBTC). Returns ok=false to ABORT the delivery (we never hand over cBTC
   * we can't get paid for). Provided by the solver (it has the escrow client).
   * If undefined, delivery proceeds without the guarantee (e.g. tests).
   */
  verifyClaimable?: (
    orderId: Hex,
    expires: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
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
  // keccak256(party) (output.recipient); the preimage is supplied off-chain. It
  // normally lives on the record (set by POST /orders), but if it's missing —
  // e.g. the order was discovered on-chain by the watcher, or a store write was
  // lost mid-submit — RECOVER it from the party-by-orderId map (written at quote
  // time). This is what makes an order deliverable even after a crash between
  // openFor and the store write. Refuse to deliver only if neither has it...
  let cantonParty = rec.cantonParty;
  if (!cantonParty) {
    const recovered = store.recallParty(orderId);
    if (recovered) {
      cantonParty = recovered;
      // Persist back onto the record so subsequent ticks don't re-recover.
      store.update(orderId, { cantonParty: recovered, note: "cantonParty recovered from quote-time map" });
    }
  }
  if (!cantonParty) {
    return { kind: "skipped", reason: "no Canton party preimage (not on record, none remembered at quote time)" };
  }
  // ...and SECURITY-CRITICAL: the preimage must hash to the committed recipient.
  // Otherwise a wrong/malicious party could redirect the cBTC. This re-checks the
  // RECOVERED party too — a poisoned recovery map can't redirect cBTC.
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

  // --- GUARD 4 (PRE-FLIGHT): WBTC collection must be GUARANTEED before we hand
  // over the cBTC, so the two legs pass-or-fail together. If the WBTC isn't
  // securely claimable (not Deposited, or too close to the refund window), we
  // ABORT — we never deliver cBTC we can't get paid for. This is the safeguard
  // against "user gets cBTC but we lose the WBTC". ---
  if (params.verifyClaimable) {
    const v = await params.verifyClaimable(orderId, rec.order.expires);
    if (!v.ok) {
      // Not safe to deliver yet — leave as `seen` to retry (transient: e.g. the
      // Deposit not yet visible) or it'll eventually expire + refund the user.
      return { kind: "skipped", reason: `pre-flight: WBTC not securely claimable — ${v.reason}` };
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

  // NOTE (Allocation investigation, 2026-06): we evaluated delivering cBTC via the
  // Splice Allocation primitive (lock → execute). E2E on mainnet proved Allocation
  // is the WRONG primitive for a one-directional delivery: it is a two-party DvP
  // settlement template (`DvpLegAllocation`) whose `Allocation_ExecuteTransfer`
  // requires BOTH executor AND receiver to co-authorize the SAME transaction —
  // impossible cross-participant (solver can't act for a user's Loop party; we got
  // DAML_AUTHORIZATION_ERROR / 403). The standard's own guidance: TransferInstruction
  // is the correct primitive for sender→receiver delivery; Allocation is for atomic
  // multi-leg DvP. So we keep the TransferInstruction (createOffer) path below.
  // (`canton.allocate/executeAllocation/withdrawAllocation` remain — lock+withdraw
  // work and are useful if a true DvP flow is ever built — but are NOT used for
  // delivery.) See docs/ALLOCATION-FINDING.md.

  // --- Create the offer (Phase 1) — TransferInstruction delivery. ---
  try {
    const holdings = await canton.getHoldings(canton.solverParty);
    const { updateId, offerContractId, autoAccepted, inputHoldingCids } = await canton.createOffer({
      receiverParty: cantonParty,
      amountBtc,
      inputHoldings: holdings,
      // Deterministic command id keyed by the swap → Canton dedupes a repeat
      // delivery of this exact order at the ledger level (CoW-aligned guard).
      commandId: `deliver-${orderId}`,
    });

    // ONLY a confirmed auto-accept collapses straight to `delivered` — the offer
    // was CONSUMED on creation (the pending transfer for our inputs is already
    // gone), so the cBTC is accepted and delivery is final.
    if (autoAccepted) {
      store.update(orderId, {
        status: "delivered",
        cbtcAccepted: true, // SECURITY (HIGH-1): cBTC handed over → never auto-refund
        cantonDeliveryRef: updateId,
        fillTimestamp: params.now,
        note: `auto-accepted on delivery (updateId=${updateId})`,
        inputHoldingCids,
      });
      return { kind: "delivered", updateId, fillTimestamp: params.now };
    }

    // Otherwise the offer is PENDING the user's accept. We must WAIT for it before
    // finalising (else we'd take the WBTC before the user has the cBTC). We track
    // the accept from the SOLVER's OWN ACS (isDeliveryAccepted, sender-readable,
    // no 403) using inputHoldingCids — works even cross-participant where the
    // receiver's offer isn't readable. resolveDeliveringOrders advances it to
    // `delivered` once the pending transfer disappears (accepted), or `failed`
    // past the fillDeadline (then the user refunds).
    store.update(orderId, {
      status: "delivering",
      cantonDeliveryRef: offerContractId || updateId,
      inputHoldingCids,
      note: offerContractId
        ? `offer created (updateId=${updateId})`
        : `cBTC offer sent — awaiting accept (cross-participant; tracked via float). updateId=${updateId}`,
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
