/**
 * Order-state store — backed by Supabase Postgres.
 *
 * The solver tracks each swap's lifecycle here. It runs as SEPARATE processes
 * (the `api` registers orders + the cantonParty; the `watch` loop delivers +
 * settles). They MUST share state, so the store lives in Postgres (the
 * `solver_orders` table) — not a local file, which separate Railway containers
 * can't share. This mirrors CoW (Postgres orders) and the rest of this app
 * (mint_transfers, redeems). See supabase/migrations/006_solver_orders.sql.
 *
 * The status machine (and the dangerous state to monitor):
 *   seen        — Open event observed, WBTC locked on origin chain
 *   delivering  — CBTC delivery to Canton in flight
 *   delivered   — CBTC delivery final on Canton (fill timestamp recorded)
 *   attested    — fill attested on our oracle
 *   finalised   — WBTC released to the solver (terminal, success)
 *   refunded    — user refunded after expiry (terminal)
 *   failed      — unrecoverable; needs manual attention
 *
 * `delivered` but not `finalised` is the DANGEROUS state (CBTC out, WBTC not yet
 * claimed) — the monitor watches it.
 *
 * Two implementations behind one interface:
 *   - SupabaseOrderStore — production (shared Postgres).
 *   - InMemoryOrderStore — tests (Map-backed, no DB; identical behavior).
 * All methods are async (the DB is remote); reload()/reloadInto() are no-ops
 * because the DB IS the shared state (no stale in-memory copy to refresh).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  /** Canton ledger record-time of the CBTC delivery (unix seconds), once known. */
  fillTimestamp?: number;
  /** Canton delivery reference (e.g. update id), once known. */
  cantonDeliveryRef?: string;
  /**
   * The Allocation contract id, when delivering via the Splice Allocation
   * primitive (USE_ALLOCATION mode). Recorded the moment the CBTC is locked, so a
   * crash/timeout before execute can `withdrawAllocation` to reclaim the float.
   */
  allocationCid?: string;
  /**
   * True once the user has ACCEPTED the CBTC on Canton — even if the accept was
   * too late to finalise on-chain. SECURITY (HIGH-1): a refund must NEVER be
   * issued for an order with this set, or the user would keep both the CBTC and
   * the refunded WBTC.
   */
  cbtcAccepted?: boolean;
  /**
   * The solver-float holding cids spent on the CBTC delivery offer. Stored so a
   * `delivering` order can be tracked for ACCEPTANCE from the SOLVER's own ACS.
   */
  inputHoldingCids?: string[];
  /** Origin-chain tx hashes for the attest + finalise legs, once sent. */
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

/**
 * The store contract. Both backends implement this; all swap code depends only on
 * this interface. Every method is async (remote DB). `reload`/`reloadInto` are
 * retained for source-compat but are no-ops (the DB is the live shared state).
 */
export interface OrderStore {
  cursorBlock(): Promise<number>;
  setCursor(block: number): Promise<void>;
  has(orderId: Hex): Promise<boolean>;
  get(orderId: Hex): Promise<OrderRecord | undefined>;
  byStatus(status: OrderStatus): Promise<OrderRecord[]>;
  byUser(user: string, statuses: OrderStatus[]): Promise<OrderRecord[]>;
  insertSeen(
    orderId: Hex,
    openBlock: number,
    order: SerializedOrder
  ): Promise<OrderRecord>;
  update(
    orderId: Hex,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>
  ): Promise<OrderRecord>;
  claimStatus(
    orderId: Hex,
    expected: OrderStatus,
    next: OrderStatus,
    patch?: Partial<Omit<OrderRecord, "orderId" | "createdAt" | "status">>
  ): Promise<boolean>;
  rememberParty(orderId: Hex, cantonParty: string): Promise<void>;
  recallParty(orderId: Hex): Promise<string | undefined>;
  /** No-op (DB is shared state). Kept for source-compat with the old file store. */
  reload(): Promise<void>;
}

// ---------- row <-> record mapping (snake_case columns <-> camelCase record) ----------

interface SolverOrderRow {
  order_id: string;
  status: OrderStatus;
  open_block: number | string;
  order_json: SerializedOrder;
  canton_party: string | null;
  fill_timestamp: number | string | null;
  canton_delivery_ref: string | null;
  allocation_cid: string | null;
  cbtc_accepted: boolean | null;
  input_holding_cids: string[] | null;
  attest_tx_hash: string | null;
  finalise_tx_hash: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(r: SolverOrderRow): OrderRecord {
  return {
    orderId: r.order_id as Hex,
    status: r.status,
    openBlock: Number(r.open_block),
    order: r.order_json,
    cantonParty: r.canton_party ?? undefined,
    fillTimestamp:
      r.fill_timestamp != null ? Number(r.fill_timestamp) : undefined,
    cantonDeliveryRef: r.canton_delivery_ref ?? undefined,
    allocationCid: r.allocation_cid ?? undefined,
    cbtcAccepted: r.cbtc_accepted ?? undefined,
    inputHoldingCids: r.input_holding_cids ?? undefined,
    attestTxHash: (r.attest_tx_hash as Hex | null) ?? undefined,
    finaliseTxHash: (r.finalise_tx_hash as Hex | null) ?? undefined,
    note: r.note ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** Map a partial OrderRecord patch to snake_case columns (only set keys). */
function patchToColumns(
  patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>
): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (patch.status !== undefined) c.status = patch.status;
  if (patch.openBlock !== undefined) c.open_block = patch.openBlock;
  if (patch.order !== undefined) c.order_json = patch.order;
  if (patch.cantonParty !== undefined) c.canton_party = patch.cantonParty;
  if (patch.fillTimestamp !== undefined) c.fill_timestamp = patch.fillTimestamp;
  if (patch.cantonDeliveryRef !== undefined)
    c.canton_delivery_ref = patch.cantonDeliveryRef;
  if (patch.allocationCid !== undefined) c.allocation_cid = patch.allocationCid;
  if (patch.cbtcAccepted !== undefined) c.cbtc_accepted = patch.cbtcAccepted;
  if (patch.inputHoldingCids !== undefined)
    c.input_holding_cids = patch.inputHoldingCids;
  if (patch.attestTxHash !== undefined) c.attest_tx_hash = patch.attestTxHash;
  if (patch.finaliseTxHash !== undefined)
    c.finalise_tx_hash = patch.finaliseTxHash;
  if (patch.note !== undefined) c.note = patch.note;
  c.updated_at = new Date().toISOString();
  return c;
}

const COLS =
  "order_id,status,open_block,order_json,canton_party,fill_timestamp,canton_delivery_ref,allocation_cid,cbtc_accepted,input_holding_cids,attest_tx_hash,finalise_tx_hash,note,created_at,updated_at";

// ---------- production: Supabase-backed ----------

export class SupabaseOrderStore implements OrderStore {
  private db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  /** Build from env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). */
  static fromEnv(): SupabaseOrderStore {
    const url =
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Supabase store needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
      );
    }
    const db = createClient(url, key, { auth: { persistSession: false } });
    return new SupabaseOrderStore(db);
  }

  async cursorBlock(): Promise<number> {
    const { data, error } = await this.db
      .from("solver_state")
      .select("cursor_block")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    return data ? Number(data.cursor_block) : 0;
  }

  async setCursor(block: number): Promise<void> {
    // Only advance — never move the cursor backwards (matches the file store).
    const current = await this.cursorBlock();
    if (block <= current) return;
    const { error } = await this.db
      .from("solver_state")
      .update({ cursor_block: block, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) throw error;
  }

  async has(orderId: Hex): Promise<boolean> {
    const { count, error } = await this.db
      .from("solver_orders")
      .select("order_id", { count: "exact", head: true })
      .eq("order_id", orderId);
    if (error) throw error;
    return (count ?? 0) > 0;
  }

  async get(orderId: Hex): Promise<OrderRecord | undefined> {
    const { data, error } = await this.db
      .from("solver_orders")
      .select(COLS)
      .eq("order_id", orderId)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToRecord(data as unknown as SolverOrderRow) : undefined;
  }

  async byStatus(status: OrderStatus): Promise<OrderRecord[]> {
    const { data, error } = await this.db
      .from("solver_orders")
      .select(COLS)
      .eq("status", status);
    if (error) throw error;
    return (data as unknown as SolverOrderRow[]).map(rowToRecord);
  }

  async byUser(user: string, statuses: OrderStatus[]): Promise<OrderRecord[]> {
    const { data, error } = await this.db
      .from("solver_orders")
      .select(COLS)
      .in("status", statuses)
      .eq("order_json->>user", user.toLowerCase());
    if (error) throw error;
    // The user is stored as-signed; compare case-insensitively in JS to be safe
    // (the index is on lower(user), but the eq above is exact on the raw value).
    const u = user.toLowerCase();
    return (data as unknown as SolverOrderRow[])
      .map(rowToRecord)
      .filter((o) => o.order.user.toLowerCase() === u);
  }

  async insertSeen(
    orderId: Hex,
    openBlock: number,
    order: SerializedOrder
  ): Promise<OrderRecord> {
    // First-write-wins: insert; on conflict do nothing, then read back the row
    // (existing or just-inserted). Idempotent — never clobbers enrichment.
    const { error } = await this.db
      .from("solver_orders")
      .insert({
        order_id: orderId,
        status: "seen",
        open_block: openBlock,
        order_json: order
      })
      .select("order_id");
    // 23505 = unique_violation (already exists) → fine, fall through to read-back.
    if (error && error.code !== "23505") throw error;
    const rec = await this.get(orderId);
    if (!rec)
      throw new Error(`insertSeen: order ${orderId} not found after upsert`);
    return rec;
  }

  async update(
    orderId: Hex,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>
  ): Promise<OrderRecord> {
    const { data, error } = await this.db
      .from("solver_orders")
      .update(patchToColumns(patch))
      .eq("order_id", orderId)
      .select(COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`order ${orderId} not found`);
    return rowToRecord(data as unknown as SolverOrderRow);
  }

  async claimStatus(
    orderId: Hex,
    expected: OrderStatus,
    next: OrderStatus,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt" | "status">> = {}
  ): Promise<boolean> {
    // Atomic CAS via the claim_solver_order RPC: a single conditional UPDATE that
    // returns the id iff status was `expected`. Two callers can't both win.
    const { data, error } = await this.db.rpc("claim_solver_order", {
      p_order_id: orderId,
      p_expected: expected,
      p_next: next,
      p_note: patch.note ?? null
    });
    if (error) throw error;
    const won = data != null && data !== "";
    if (!won) return false;
    // Apply any non-note patch fields (the RPC only sets status + note). Rare —
    // most claims pass only a note — but keep behavior identical to the file store.
    const rest = { ...patch };
    delete (rest as { note?: string }).note;
    if (Object.keys(rest).length > 0) {
      await this.update(orderId, rest);
    }
    return true;
  }

  async rememberParty(orderId: Hex, cantonParty: string): Promise<void> {
    // The recovery map collapses into solver_orders.canton_party. Update the row
    // if it exists; if not yet inserted, this is a no-op (insertSeen + update in
    // the write-ahead sequence sets it). Idempotent.
    const { error } = await this.db
      .from("solver_orders")
      .update({
        canton_party: cantonParty,
        updated_at: new Date().toISOString()
      })
      .eq("order_id", orderId)
      .is("canton_party", null); // only set if not already set — avoid churn/clobber
    if (error) throw error;
  }

  async recallParty(orderId: Hex): Promise<string | undefined> {
    const { data, error } = await this.db
      .from("solver_orders")
      .select("canton_party")
      .eq("order_id", orderId)
      .maybeSingle();
    if (error) throw error;
    return (data?.canton_party as string | null) ?? undefined;
  }

  async reload(): Promise<void> {
    /* no-op: the DB is the shared state */
  }
}

// ---------- tests: in-memory ----------

/**
 * Map-backed store with identical async behavior — for unit tests (no DB).
 * claimStatus is trivially atomic in single-threaded JS (no await between the
 * status check and the write), preserving the double-delivery guard semantics.
 */
export class InMemoryOrderStore implements OrderStore {
  private orders = new Map<string, OrderRecord>();
  private cursor = 0;

  async cursorBlock(): Promise<number> {
    return this.cursor;
  }
  async setCursor(block: number): Promise<void> {
    if (block > this.cursor) this.cursor = block;
  }
  async has(orderId: Hex): Promise<boolean> {
    return this.orders.has(orderId);
  }
  async get(orderId: Hex): Promise<OrderRecord | undefined> {
    const r = this.orders.get(orderId);
    return r ? { ...r } : undefined;
  }
  async byStatus(status: OrderStatus): Promise<OrderRecord[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === status)
      .map((o) => ({ ...o }));
  }
  async byUser(user: string, statuses: OrderStatus[]): Promise<OrderRecord[]> {
    const u = user.toLowerCase();
    const set = new Set(statuses);
    return [...this.orders.values()]
      .filter((o) => set.has(o.status) && o.order.user.toLowerCase() === u)
      .map((o) => ({ ...o }));
  }
  async insertSeen(
    orderId: Hex,
    openBlock: number,
    order: SerializedOrder
  ): Promise<OrderRecord> {
    const existing = this.orders.get(orderId);
    if (existing) return { ...existing }; // first-write-wins
    const now = new Date().toISOString();
    const rec: OrderRecord = {
      orderId,
      status: "seen",
      openBlock,
      order,
      createdAt: now,
      updatedAt: now
    };
    this.orders.set(orderId, rec);
    return { ...rec };
  }
  async update(
    orderId: Hex,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt">>
  ): Promise<OrderRecord> {
    const rec = this.orders.get(orderId);
    if (!rec) throw new Error(`order ${orderId} not found`);
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    return { ...rec };
  }
  async claimStatus(
    orderId: Hex,
    expected: OrderStatus,
    next: OrderStatus,
    patch: Partial<Omit<OrderRecord, "orderId" | "createdAt" | "status">> = {}
  ): Promise<boolean> {
    const rec = this.orders.get(orderId);
    if (!rec || rec.status !== expected) return false;
    Object.assign(rec, patch, {
      status: next,
      updatedAt: new Date().toISOString()
    });
    return true;
  }
  async rememberParty(orderId: Hex, cantonParty: string): Promise<void> {
    const rec = this.orders.get(orderId);
    if (rec && rec.cantonParty == null) {
      rec.cantonParty = cantonParty;
      rec.updatedAt = new Date().toISOString();
    }
  }
  async recallParty(orderId: Hex): Promise<string | undefined> {
    return this.orders.get(orderId)?.cantonParty;
  }
  async reload(): Promise<void> {
    /* no-op */
  }
}
