/**
 * Supabase-backed HTLC order store (R5). Persists SwapOrders to htlc_orders so they
 * survive restarts (was an in-memory Map). Server-side only (service-role key).
 *
 * Maps the camelCase SwapOrder <-> snake_case htlc_orders row.
 */
import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";
import type { SwapOrder, SwapStatus } from "./htlc-types";

const TABLE = "htlc_orders";

function rowToOrder(r: Record<string, unknown>): SwapOrder {
  return {
    id: r.id as string,
    direction: r.direction as SwapOrder["direction"],
    status: r.status as SwapStatus,
    hashLock: r.hash_lock as `0x${string}`,
    userEvmAddress: (r.user_evm_address as string) ?? undefined,
    solverEvmAddress: (r.solver_evm_address as string) ?? undefined,
    wbtcAmount: (r.wbtc_amount as string) ?? undefined,
    userTimelock: Number(r.user_timelock),
    userCantonParty: r.user_canton_party as string,
    solverCantonParty: r.solver_canton_party as string,
    cbtcAmount: (r.cbtc_amount as string) ?? undefined,
    solverTimelock: Number(r.solver_timelock),
    mainLockTx: (r.main_lock_tx as string) ?? undefined,
    counterLockTx: (r.counter_lock_tx as string) ?? undefined,
    counterClaimUpdateId: (r.counter_claim_update_id as string) ?? undefined,
    revealedPreimage: (r.revealed_preimage as `0x${string}`) ?? undefined,
    mainClaimTx: (r.main_claim_tx as string) ?? undefined,
    counterMode: (r.counter_mode as "managed" | "loop") ?? undefined,
    allocationCid: (r.allocation_cid as string) ?? undefined,
    htlcCid: (r.htlc_cid as string) ?? undefined,
    htlcBlob: (r.htlc_blob as string) ?? undefined,
    counterTransferOfferCid: (r.counter_transfer_offer_cid as string) ?? undefined,
    counterTransferUpdateId: (r.counter_transfer_update_id as string) ?? undefined,
    createdAt: r.created_at ? Math.floor(new Date(r.created_at as string).getTime() / 1000) : 0,
  };
}

function orderToRow(o: SwapOrder): Record<string, unknown> {
  return {
    id: o.id,
    direction: o.direction,
    status: o.status,
    hash_lock: o.hashLock,
    user_evm_address: o.userEvmAddress ?? null,
    solver_evm_address: o.solverEvmAddress ?? null,
    wbtc_amount: o.wbtcAmount ?? null,
    user_timelock: o.userTimelock,
    user_canton_party: o.userCantonParty,
    solver_canton_party: o.solverCantonParty,
    cbtc_amount: o.cbtcAmount ?? null,
    solver_timelock: o.solverTimelock,
    main_lock_tx: o.mainLockTx ?? null,
    counter_lock_tx: o.counterLockTx ?? null,
    counter_claim_update_id: o.counterClaimUpdateId ?? null,
    revealed_preimage: o.revealedPreimage ?? null,
    main_claim_tx: o.mainClaimTx ?? null,
    counter_mode: o.counterMode ?? null,
    allocation_cid: o.allocationCid ?? null,
    htlc_cid: o.htlcCid ?? null,
    htlc_blob: o.htlcBlob ?? null,
    counter_transfer_offer_cid: o.counterTransferOfferCid ?? null,
    counter_transfer_update_id: o.counterTransferUpdateId ?? null,
    updated_at: new Date().toISOString(),
  };
}

export interface SwapStore {
  get(id: string): Promise<SwapOrder | undefined>;
  put(o: SwapOrder): Promise<void>;
  byStatus(s: SwapStatus): Promise<SwapOrder[]>;
  active(): Promise<SwapOrder[]>;
  /** Order history for one user party, newest first. */
  byParty(party: string, limit?: number): Promise<SwapOrder[]>;
}

export class SupabaseSwapStore implements SwapStore {
  async get(id: string): Promise<SwapOrder | undefined> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`htlc_orders get: ${error.message}`);
    return data ? rowToOrder(data) : undefined;
  }
  async put(o: SwapOrder): Promise<void> {
    const sb = await createSupabaseServiceClient();
    const { error } = await sb.from(TABLE).upsert(orderToRow(o), { onConflict: "id" });
    if (error) throw new Error(`htlc_orders put: ${error.message}`);
  }
  async byStatus(s: SwapStatus): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("status", s);
    if (error) throw new Error(`htlc_orders byStatus: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }
  async byParty(party: string, limit = 50): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*")
      .eq("user_canton_party", party)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`htlc_orders byParty: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }
  async active(): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*")
      .not("status", "in", "(main_claimed,refunded,cancelled,failed)");
    if (error) throw new Error(`htlc_orders active: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }
}
