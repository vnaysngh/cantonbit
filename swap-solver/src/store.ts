/**
 * Resumable order-state store.
 *
 * A crash-safe JSON file mapping orderId -> order record + a block cursor so the
 * watcher resumes from where it left off. Single-process: the solver is one
 * worker, so we use a simple read-modify-write with atomic file replacement
 * (write tmp, then rename) to avoid torn writes.
 *
 * The status machine (and the dangerous state to monitor):
 *   seen        — Open event observed, WBTC locked on Base
 *   delivering  — cBTC delivery to Canton in flight
 *   delivered   — cBTC delivery final on Canton (fill timestamp recorded)
 *   attested    — fill attested on our oracle (Base)
 *   finalised   — WBTC released to the solver (terminal, success)
 *   refunded    — user refunded after expiry (terminal)
 *   failed      — unrecoverable; needs manual attention
 *
 * `delivered` but not `finalised` is the DANGEROUS state (cBTC out, WBTC not yet
 * claimed) — Task 11 monitors it.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";

export type OrderStatus =
  | "seen"
  | "delivering"
  | "delivered"
  | "attested"
  | "finalised"
  | "refunded"
  | "failed";

/** Persisted record for a single swap order. The `order` is stored as the raw
 *  decoded event args (bigints serialized as strings — see (de)serialize). */
export interface OrderRecord {
  orderId: Hex;
  status: OrderStatus;
  /** Block number the Open event was seen at (for audit/debug). */
  openBlock: number;
  /** The decoded StandardOrder, serialized (bigints as strings). */
  order: SerializedOrder;
  /**
   * The full Canton destination party (preimage of output.recipient =
   * keccak256(party)). NOT on-chain — supplied by the off-chain swap request and
   * verified to match the committed hash before delivery. Undefined until matched.
   */
  cantonParty?: string;
  /** Canton ledger record-time of the cBTC delivery (unix seconds), once known. */
  fillTimestamp?: number;
  /** Canton delivery reference (e.g. update id), once known. */
  cantonDeliveryRef?: string;
  /**
   * True once the user has ACCEPTED the cBTC on Canton — even if the accept was
   * too late to finalise on-chain. SECURITY (HIGH-1): a refund must NEVER be
   * issued for an order with this set, or the user would keep both the cBTC and
   * the refunded WBTC. Distinguishes a `failed` order whose cBTC was delivered
   * (NOT refundable — needs manual review) from a clean unfilled failure
   * (refundable). Set wherever an accept is detected.
   */
  cbtcAccepted?: boolean;
  /**
   * The solver-float holding cids spent on the cBTC delivery offer. Stored so a
   * `delivering` order can be tracked for ACCEPTANCE from the SOLVER's own ACS
   * (sender-readable, no 403): while pending, a TransferInstruction / locked
   * holding for these cids is in our active contracts; once the user accepts, it
   * disappears. This is how we WAIT for the accept before finalising, even
   * cross-participant where we can't read the receiver's offer.
   */
  inputHoldingCids?: string[];
  /** Base tx hashes for the attest + finalise legs, once sent. */
  attestTxHash?: Hex;
  finaliseTxHash?: Hex;
  /** Free-form note for failures / manual recovery. */
  note?: string;
  /** ISO timestamps for observability. */
  createdAt: string;
  updatedAt: string;
}

/** StandardOrder with bigints as decimal strings (JSON-safe). */
export interface SerializedOrder {
  user: Hex;
  nonce: string;
  originChainId: string;
  expires: number;
  fillDeadline: number;
  inputOracle: Hex;
  inputs: [string, string][];
  outputs: {
    oracle: Hex;
    settler: Hex;
    chainId: string;
    token: Hex;
    amount: string;
    recipient: Hex;
    callbackData: Hex;
    context: Hex;
  }[];
}

interface StoreFile {
  /** Last block fully processed by the watcher; resume from cursor+1. */
  cursorBlock: number;
  orders: Record<string, OrderRecord>;
  /**
   * Recovery map: orderId → full Canton party (the preimage of the order's
   * recipient hash). Written at QUOTE time — the earliest point the party is
   * known — so the party is durable BEFORE any on-chain action. If the order's
   * own record ever lacks cantonParty (e.g. a watcher discovered it on-chain, or
   * a store write was lost mid-submit), the delivery path recovers it from here.
   * The on-chain order only commits keccak256(party); without this the preimage
   * would be unrecoverable and the order undeliverable. Verified-on-use: the
   * recovered party is re-hashed against the committed recipient before delivery.
   */
  partyByOrderId?: Record<string, string>;
}

export class OrderStore {
  private path: string;
  private data: StoreFile;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    } else {
      this.data = { cursorBlock: 0, orders: {} };
      mkdirSync(dirname(path), { recursive: true });
      this.flush();
    }
  }

  /** Block to resume scanning from (exclusive of already-processed). */
  get cursorBlock(): number {
    return this.data.cursorBlock;
  }

  /** Advance the cursor after a block range is fully processed. */
  setCursor(block: number): void {
    if (block > this.data.cursorBlock) {
      this.data.cursorBlock = block;
      this.flush();
    }
  }

  has(orderId: Hex): boolean {
    return orderId in this.data.orders;
  }

  get(orderId: Hex): OrderRecord | undefined {
    return this.data.orders[orderId];
  }

  /** All orders in a given status (e.g. the dangerous `delivered` set). */
  byStatus(status: OrderStatus): OrderRecord[] {
    return Object.values(this.data.orders).filter((o) => o.status === status);
  }

  /**
   * Re-read the store file from disk into memory. The solver runs as MULTIPLE
   * processes sharing one file (the API registers orders + cantonParty; the loop
   * delivers/settles). Each must see the other's writes, so the loop calls this
   * at the top of every tick, and writes merge-from-disk (see reloadInto).
   */
  reload(): void {
    if (existsSync(this.path)) {
      this.data = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
    }
  }

  /** Read the latest file state so a write doesn't clobber another process's. */
  private reloadInto(): void {
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
      } catch { /* mid-write torn read is impossible (atomic rename) but be safe */ }
    }
  }

  /** Insert a newly-seen order. Idempotent: existing record (e.g. one the API
   *  already enriched with cantonParty) is preserved, not overwritten. */
  insertSeen(orderId: Hex, openBlock: number, order: SerializedOrder): OrderRecord {
    this.reloadInto(); // pick up the other process's writes before deciding
    const existing = this.data.orders[orderId];
    if (existing) return existing; // first-write-wins; never clobber enrichment
    const now = new Date().toISOString();
    const rec: OrderRecord = {
      orderId,
      status: "seen",
      openBlock,
      order,
      createdAt: now,
      updatedAt: now,
    };
    this.data.orders[orderId] = rec;
    this.flush();
    return rec;
  }

  /** Patch an order record (status transitions + leg metadata). Merges against
   *  the latest on-disk state so a concurrent process's fields aren't lost. */
  update(orderId: Hex, patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>): OrderRecord {
    this.reloadInto(); // merge against latest disk state (other process may have written)
    const rec = this.data.orders[orderId];
    if (!rec) throw new Error(`order ${orderId} not found`);
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    this.flush();
    return rec;
  }

  /**
   * Atomic compare-and-set on status — the claim primitive that prevents
   * double-processing under concurrency. Reloads latest disk state, and ONLY if
   * the order is still in `expected` status, transitions it to `next` (+ patch)
   * and persists. Returns true if THIS caller won the claim, false if someone
   * else already moved it. reload+check+flush is synchronous (no await between),
   * so two callers can't both observe `expected` and both win.
   *
   * Used to claim a `seen` order into `delivering` BEFORE the async delivery, so
   * a racing process (API + watch loop) can't deliver the same order twice.
   */
  claimStatus(
    orderId: Hex,
    expected: OrderStatus,
    next: OrderStatus,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt" | "status">> = {},
  ): boolean {
    this.reloadInto();
    const rec = this.data.orders[orderId];
    if (!rec || rec.status !== expected) return false;
    Object.assign(rec, patch, { status: next, updatedAt: new Date().toISOString() });
    this.flush();
    return true;
  }

  /**
   * Record the cantonParty for an orderId in the recovery map (called at QUOTE
   * time). Durable BEFORE any on-chain action, so the preimage survives a crash
   * during submit and is available to a watcher-discovered order. Idempotent.
   */
  rememberParty(orderId: Hex, cantonParty: string): void {
    this.reloadInto();
    if (!this.data.partyByOrderId) this.data.partyByOrderId = {};
    if (this.data.partyByOrderId[orderId] === cantonParty) return; // no-op, avoid churn
    this.data.partyByOrderId[orderId] = cantonParty;
    this.flush();
  }

  /** Look up a remembered cantonParty for an orderId (recovery map), or undefined. */
  recallParty(orderId: Hex): string | undefined {
    this.reloadInto();
    return this.data.partyByOrderId?.[orderId];
  }

  /** Atomic persist: write to a tmp file then rename over the real path. */
  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
