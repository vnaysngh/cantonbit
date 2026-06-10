/**
 * Refund logic — shared by the HTTP handler (POST /orders/:id/refund) and the
 * watch loop's auto-refund sweep. Single source of truth so on-demand and
 * automatic refunds behave identically.
 *
 * refund() is PERMISSIONLESS: the escrow always returns the locked inputs to
 * order.user, so it's safe for the solver to submit on the user's behalf (funds
 * go to the user regardless of who pays gas). This is what lets us auto-refund a
 * stalled swap without the user lifting a finger.
 *
 * Two-legged settlement means a stalled order leaves real WBTC locked in escrow.
 * The user's only guarantee is the `expires` timeout, after which this returns
 * their funds. We sweep every tick so that guarantee is automatic.
 */
import { getContract, type Hex, type PublicClient, type WalletClient, type Account } from "viem";

import { ESCROW_ABI } from "./abi.js";
import { deserializeOrder } from "./convert.js";
import type { OrderStore, OrderRecord } from "./store.js";

/** On-chain OrderStatus enum: { None, Deposited, Claimed, Refunded }. */
const ONCHAIN_CLAIMED = 2;
const ONCHAIN_REFUNDED = 3;

export type RefundOutcome =
  | { kind: "refunded"; refundTx: Hex }
  | { kind: "alreadyRefunded" }
  | { kind: "alreadyFinalised" } // claimed on-chain by a late finalise
  | { kind: "notYet"; secondsLeft: number }
  | { kind: "error"; message: string };

export interface RefundDeps {
  store: OrderStore;
  escrow: Hex;
  wallet: WalletClient;
  account: Account;
  pub: PublicClient;
}

/**
 * Refund a single expired, unfinalised order. Idempotent and safe to call on an
 * order that was already claimed/refunded on-chain — it reconciles the store
 * with chain truth instead of throwing.
 */
export async function refundOrder(
  rec: OrderRecord,
  deps: RefundDeps,
  now: number
): Promise<RefundOutcome> {
  const { store, escrow, wallet, account, pub } = deps;
  const orderId = rec.orderId;

  if (rec.status === "finalised") return { kind: "alreadyFinalised" };
  if (rec.status === "refunded") return { kind: "alreadyRefunded" };

  // SECURITY (HIGH-1) — the bulletproof guard: NEVER refund an order whose cBTC
  // the user has already accepted. `cbtcAccepted` is set the moment an accept is
  // detected ANYWHERE (auto-accept on delivery, ACS detection, even accepted-but-
  // too-late-to-finalise), independent of status. Refunding such an order would
  // hand the user BOTH legs (cBTC + refunded WBTC) at the treasury's expense.
  // This also protects the public POST /orders/:id/refund endpoint from being
  // used to refund a delivered order. Status check is the coarse signal;
  // cbtcAccepted is the precise one (catches the `failed`-but-accepted case).
  if (rec.cbtcAccepted || rec.status === "delivered" || rec.status === "attested") {
    return {
      kind: "error",
      message:
        "refusing to refund — the cBTC was already accepted by the user; this must be finalised (or manually reviewed), not refunded",
    };
  }

  // The signed order carries its own immutable expiry; honor it exactly.
  if (now <= rec.order.expires) {
    return { kind: "notYet", secondsLeft: rec.order.expires - now };
  }

  const order = deserializeOrder(rec.order);
  const escrowC = getContract({ address: escrow, abi: ESCROW_ABI, client: wallet });

  // Reconcile with chain truth first — a late finalise may have claimed it, or a
  // previous sweep may have already refunded it.
  const onchain = Number(await escrowC.read.orderStatus([orderId]));
  if (onchain === ONCHAIN_CLAIMED) {
    await store.update(orderId, { status: "finalised", note: "claimed on-chain (late finalise)" });
    return { kind: "alreadyFinalised" };
  }
  if (onchain === ONCHAIN_REFUNDED) {
    await store.update(orderId, { status: "refunded", note: "already refunded on-chain" });
    return { kind: "alreadyRefunded" };
  }

  try {
    const refundTx = await escrowC.write.refund([order], { account, chain: null });
    await pub.waitForTransactionReceipt({ hash: refundTx });
    await store.update(orderId, { status: "refunded", note: `refund ${refundTx}` });
    return { kind: "refunded", refundTx };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sweep: auto-refund every order that's past its expiry and not yet
 * finalised/refunded. Called each watch-loop tick. Returns the orders it acted
 * on (for logging). Never throws — a single bad order doesn't stop the sweep.
 */
export async function refundExpiredOrders(
  deps: RefundDeps,
  now: number
): Promise<{ orderId: Hex; outcome: RefundOutcome }[]> {
  const { store } = deps;
  // Candidates: ONLY orders where the cBTC has NOT yet been handed to the user —
  // `seen` (no delivery) and `delivering` (offer created, NOT yet accepted). For
  // these, refunding the WBTC is loss-free: the solver still holds its cBTC.
  //
  // SECURITY (HIGH-1): `delivered`/`attested` are DELIBERATELY EXCLUDED. In those
  // states the user has ALREADY accepted the cBTC on Canton — auto-refunding the
  // WBTC there would hand the user BOTH legs (cBTC + refunded WBTC) and the
  // treasury eats the loss. A `delivered` order past expiry must be SETTLED
  // (finalise keeps working after expiry on-chain), never refunded; the watch
  // loop keeps retrying attest+finalise and a stuck one needs manual review, not
  // an auto-refund.
  const [seenRecs, deliveringRecs] = await Promise.all([
    store.byStatus("seen"),
    store.byStatus("delivering"),
  ]);
  const candidates = [...seenRecs, ...deliveringRecs].filter((o) => now > o.order.expires);

  const results: { orderId: Hex; outcome: RefundOutcome }[] = [];
  for (const rec of candidates) {
    try {
      const outcome = await refundOrder(rec, deps, now);
      results.push({ orderId: rec.orderId, outcome });
    } catch (e) {
      results.push({
        orderId: rec.orderId,
        outcome: { kind: "error", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }
  return results;
}
