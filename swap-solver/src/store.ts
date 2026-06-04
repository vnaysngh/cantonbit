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

  /** Insert a newly-seen order. Idempotent: ignored if the orderId exists. */
  insertSeen(orderId: Hex, openBlock: number, order: SerializedOrder): OrderRecord {
    const existing = this.data.orders[orderId];
    if (existing) return existing;
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

  /** Patch an order record (status transitions + leg metadata). */
  update(orderId: Hex, patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>): OrderRecord {
    const rec = this.data.orders[orderId];
    if (!rec) throw new Error(`order ${orderId} not found`);
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    this.flush();
    return rec;
  }

  /** Atomic persist: write to a tmp file then rename over the real path. */
  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
