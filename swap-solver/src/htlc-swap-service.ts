/**
 * REFERENCE / TEST ONLY — NOT WIRED TO PRODUCTION ROUTES.
 *
 * Production HTLC lifecycle (margin checks, Loop paths, on-ledger HtlcLock, etc.)
 * lives in `lib/htlc-service-singleton.ts`. This module is kept for
 * `htlc-swap-service.test.ts` and design docs only — it has no `verifyEvmLock` and
 * must not be imported by daemons or API handlers.
 *
 * HTLC swap service (B-FE1/B-FE2/B-FE4) — the order lifecycle + the Cancore-style
 * /htlc API, driving the REAL user-claims atomic-swap flow (not a plain transfer).
 *
 * Mirrors Cancore's mechanism (confirmed from their API):
 *   - claim-counter is a BACKEND call: user POSTs the preimage, the backend
 *     verifies keccak(preimage)==hashLock, releases the CBTC, and STORES the
 *     preimage so the solver claims the EVM side. (CBTC has no on-ledger hashlock
 *     — T1 — so the hash gate is the orchestrator's; structurally this is the
 *     correct user-claims flow, trust-minimized on CBTC.)
 *
 * Statuses (Cancore-aligned):
 *   open → accepted → main_locked → counter_locked (htlc_active)
 *        → counter_claimed (preimage revealed) → main_claimed (completed)
 *        | refunded
 *
 * EVM→Canton (UC7/UC8) role mapping:
 *   maker  = user  (sells WBTC on EVM, buys CBTC on Canton)
 *   taker  = solver(buys WBTC, sells CBTC)
 *   3. maker locks WBTC on EVM (frontend MetaMask)            → main_locked
 *   4. solver locks CBTC counter on Canton                    → counter_locked
 *   6. maker claims counter (POST preimage) → CBTC released   → counter_claimed
 *   7. solver claims main on EVM with the preimage            → main_claimed
 */

import { keccak256, type Hex } from "viem";

import { CantonClient } from "./canton.js";
import { releaseCbtcOnReveal } from "./htlc-canton-leg.js";

export type SwapDirection = "evm-to-canton" | "canton-to-evm";

export type SwapStatus =
  | "open" // order created, waiting for the solver to accept
  | "accepted" // solver took the order
  | "main_locked" // the EVM HTLC is locked (the "main" leg)
  | "counter_locked" // the Canton CBTC counter is locked (htlc_active)
  | "counter_claimed" // user revealed the preimage; CBTC released
  | "main_claimed" // solver claimed the EVM leg; swap complete
  | "refunded"
  | "failed";

export interface SwapOrder {
  id: string; // swapId
  direction: SwapDirection;
  status: SwapStatus;
  hashLock: Hex; // H = keccak256(secret)
  // EVM leg
  userEvmAddress: Hex;
  solverEvmAddress: Hex;
  wbtcAmount: string; // base units (string for JSON safety)
  userTimelock: number; // EVM unlock (the longer leg)
  // Canton leg
  userCantonParty: string;
  solverCantonParty: string;
  cbtcAmount: string; // BTC decimal string
  solverTimelock: number; // Canton unlock (shorter leg)
  // lifecycle data
  mainLockTx?: Hex; // EVM lock tx (step 3)
  counterOfferUpdateId?: string; // Canton counter lock (step 4)
  revealedPreimage?: Hex; // captured at claim-counter (step 6)
  counterClaimUpdateId?: string;
  mainClaimTx?: Hex; // EVM claim (step 7)
  createdAt: number;
}

/** Minimal in-memory store (production: Supabase, like the existing solver). */
export interface SwapStore {
  get(id: string): Promise<SwapOrder | undefined>;
  put(o: SwapOrder): Promise<void>;
  byStatus(s: SwapStatus): Promise<SwapOrder[]>;
}

export class InMemorySwapStore implements SwapStore {
  private m = new Map<string, SwapOrder>();
  async get(id: string) {
    return this.m.get(id);
  }
  async put(o: SwapOrder) {
    this.m.set(o.id, o);
  }
  async byStatus(s: SwapStatus) {
    return [...this.m.values()].filter((o) => o.status === s);
  }
}

/** keccak256 of the canton preimage form (hex string) == hashLock? */
function preimageMatches(preimageHex: string, hashLock: Hex): boolean {
  const clean = preimageHex.startsWith("0x")
    ? preimageHex.slice(2)
    : preimageHex;
  if (clean.length % 2 !== 0) return false;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return keccak256(bytes).toLowerCase() === hashLock.toLowerCase();
}

export class HtlcSwapService {
  constructor(
    private store: SwapStore,
    private canton: CantonClient
  ) {}

  /** STEP 1 — create the order (the user has committed to H + timelocks off-chain
   *  via the EIP-712 order signature; this records it server-side). */
  async createOrder(
    o: Omit<SwapOrder, "status" | "createdAt">
  ): Promise<SwapOrder> {
    const order: SwapOrder = {
      ...o,
      status: "open",
      createdAt: Math.floor(Date.now() / 1000)
    };
    await this.store.put(order);
    return order;
  }

  /** STEP 2 — the solver accepts the order. */
  async accept(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "open")
      throw new Error(`order ${id} not open (status ${o.status})`);
    o.status = "accepted";
    await this.store.put(o);
    return o;
  }

  /** STEP 3 — record that the maker locked the EVM "main" HTLC (the frontend does
   *  the MetaMask lock; this confirms it and advances state). The solver should
   *  verify the on-chain lock before calling this (done by the caller/watcher). */
  async recordMainLock(id: string, mainLockTx: Hex): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "accepted")
      throw new Error(`order ${id} not accepted (status ${o.status})`);
    o.status = "main_locked";
    o.mainLockTx = mainLockTx;
    await this.store.put(o);
    return o;
  }

  /** STEP 4 — the SOLVER locks the CBTC counter on Canton. CBTC has no on-ledger
   *  hashlock, so this is the orchestrator-gated lock: the CBTC is reserved for
   *  the user and released ONLY when the user claims with the correct preimage
   *  (claimCounter). We hold it as the solver's float, NOT delivered yet — the
   *  delivery happens at claimCounter (which is the user's reveal). This is the
   *  trust-minimized substitute for an on-ledger HTLC lock. */
  async lockCounter(id: string): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "main_locked")
      throw new Error(`order ${id} main not locked (status ${o.status})`);
    // No on-chain Canton lock to make here (CBTC can't hashlock). We mark the
    // counter as "locked" meaning the solver has COMMITTED the float to this swap
    // and will release it on a valid preimage. (A production impl reserves the
    // float / uses an Allocation as a refundable hold.)
    o.status = "counter_locked";
    await this.store.put(o);
    return o;
  }

  /** STEP 6 — claim-counter (THE USER'S REVEAL). The user POSTs the preimage. We
   *  verify keccak(preimage)==hashLock, RELEASE the CBTC to the user (the real
   *  delivery), STORE the preimage so the solver can claim the EVM leg, and
   *  advance to counter_claimed. Returns "invalid preimage" if it doesn't match —
   *  this IS the orchestrator hash gate (same as Cancore's claim-counter). */
  async claimCounter(
    id: string,
    preimageHex: string
  ): Promise<{ order: SwapOrder; updateId: string }> {
    const o = await this.must(id);
    if (o.status !== "counter_locked")
      throw new Error(`order ${id} counter not locked (status ${o.status})`);
    if (!preimageMatches(preimageHex, o.hashLock)) {
      throw new Error("invalid preimage — does not match hashLock");
    }
    // RELEASE the CBTC to the user now (the reveal triggers the delivery).
    const rel = await releaseCbtcOnReveal(
      this.canton,
      {
        receiverParty: o.userCantonParty,
        amountBtc: o.cbtcAmount,
        swapId: o.id,
        solverTimelock: o.solverTimelock
      },
      { preimageHex, hashLock: o.hashLock }
    );
    if (rel.kind !== "released")
      throw new Error(`CBTC release failed: ${JSON.stringify(rel)}`);
    // STORE the revealed preimage (as 0x-hex bytes) for the solver's EVM claim.
    o.revealedPreimage = ("0x" +
      (preimageHex.startsWith("0x")
        ? preimageHex.slice(2)
        : preimageHex)) as Hex;
    o.counterClaimUpdateId = rel.updateId;
    o.status = "counter_claimed";
    await this.store.put(o);
    return { order: o, updateId: rel.updateId };
  }

  /** STEP 7 — record the solver's EVM claim (the solver reads revealedPreimage and
   *  claims the main HTLC; the caller does the on-chain claim, this advances state). */
  async recordMainClaim(id: string, mainClaimTx: Hex): Promise<SwapOrder> {
    const o = await this.must(id);
    if (o.status !== "counter_claimed")
      throw new Error(`order ${id} counter not claimed (status ${o.status})`);
    o.status = "main_claimed";
    o.mainClaimTx = mainClaimTx;
    await this.store.put(o);
    return o;
  }

  /** GET /htlc/{id}/preimage — return the revealed preimage (only after reveal). */
  async getRevealedPreimage(id: string): Promise<Hex | undefined> {
    return (await this.must(id)).revealedPreimage;
  }

  /** GET /htlc/{id} — fetch an order (for the UI timeline). undefined if absent. */
  async getOrder(id: string): Promise<SwapOrder | undefined> {
    return this.store.get(id);
  }

  /** List orders by status (order book / solver matching). */
  async listByStatus(s: SwapStatus): Promise<SwapOrder[]> {
    return this.store.byStatus(s);
  }

  private async must(id: string): Promise<SwapOrder> {
    const o = await this.store.get(id);
    if (!o) throw new Error(`swap ${id} not found`);
    return o;
  }
}
