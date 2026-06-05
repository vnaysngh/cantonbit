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
    store.update(orderId, { status: "finalised", note: "claimed on-chain (late finalise)" });
    return { kind: "alreadyFinalised" };
  }
  if (onchain === ONCHAIN_REFUNDED) {
    store.update(orderId, { status: "refunded", note: "already refunded on-chain" });
    return { kind: "alreadyRefunded" };
  }

  try {
    const refundTx = await escrowC.write.refund([order], { account, chain: null });
    await pub.waitForTransactionReceipt({ hash: refundTx });
    store.update(orderId, { status: "refunded", note: `refund ${refundTx}` });
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
  // Candidates: anything locked but not settled. `seen`/`delivering`/`delivered`
  // are the non-terminal states where WBTC is still in escrow.
  const candidates = [
    ...store.byStatus("seen"),
    ...store.byStatus("delivering"),
    ...store.byStatus("delivered"),
  ].filter((o) => now > o.order.expires);

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
