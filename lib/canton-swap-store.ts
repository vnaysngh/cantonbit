import "server-only";

import { fromBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset } from "./canton-assets";
import { createSupabaseServiceClient } from "./supabase/server";
import type {
  CantonSwapOrder,
  CantonSwapStatus,
  CantonSwapWalletMode
} from "./canton-swap-types";

const TABLE = "canton_swap_orders";

function rowToOrder(r: Record<string, unknown>): CantonSwapOrder {
  return {
    id: r.id as string,
    status: r.status as CantonSwapStatus,
    fromAsset: r.from_asset as CantonSwapOrder["fromAsset"],
    toAsset: r.to_asset as CantonSwapOrder["toAsset"],
    inAmount: r.in_amount as string,
    outAmount: r.out_amount as string,
    minOut: r.min_out as string,
    quoteExpiresAt: Math.floor(
      new Date(r.quote_expires_at as string).getTime() / 1000
    ),
    userParty: r.user_party as string,
    solverParty: r.solver_party as string,
    walletMode: r.wallet_mode as CantonSwapWalletMode,
    userLegOfferCid: (r.user_leg_offer_cid as string) ?? undefined,
    counterLegOfferCid: (r.counter_leg_offer_cid as string) ?? undefined,
    settlementUpdateId: (r.settlement_update_id as string) ?? undefined,
    failureReason: (r.failure_reason as string) ?? undefined,
    createdAt: r.created_at
      ? Math.floor(new Date(r.created_at as string).getTime() / 1000)
      : 0
  };
}

function orderToRow(o: CantonSwapOrder): Record<string, unknown> {
  return {
    id: o.id,
    status: o.status,
    from_asset: o.fromAsset,
    to_asset: o.toAsset,
    in_amount: o.inAmount,
    out_amount: o.outAmount,
    min_out: o.minOut,
    quote_expires_at: new Date(o.quoteExpiresAt * 1000).toISOString(),
    user_party: o.userParty,
    solver_party: o.solverParty,
    wallet_mode: o.walletMode,
    user_leg_offer_cid: o.userLegOfferCid ?? null,
    counter_leg_offer_cid: o.counterLegOfferCid ?? null,
    settlement_update_id: o.settlementUpdateId ?? null,
    failure_reason: o.failureReason ?? null,
    updated_at: new Date().toISOString()
  };
}

export interface CantonSwapStore {
  get(id: string): Promise<CantonSwapOrder | undefined>;
  put(o: CantonSwapOrder): Promise<void>;
  /** Optimistic status transition — returns false if status changed concurrently. */
  putIfStatus(o: CantonSwapOrder, expectedStatus: CantonSwapStatus): Promise<boolean>;
  byStatus(status: CantonSwapStatus): Promise<CantonSwapOrder[]>;
  byParty(party: string, limit?: number): Promise<CantonSwapOrder[]>;
  /** Sum out_amount reserved by committed orders (excludes draft `open` intents). */
  sumReservedOut(
    solverParty: string,
    toAsset: CantonSwapOrder["toAsset"]
  ): Promise<string>;
}

export class SupabaseCantonSwapStore implements CantonSwapStore {
  async get(id: string): Promise<CantonSwapOrder | undefined> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`canton_swap_orders get: ${error.message}`);
    return data ? rowToOrder(data) : undefined;
  }

  async put(o: CantonSwapOrder): Promise<void> {
    const sb = await createSupabaseServiceClient();
    const { error } = await sb
      .from(TABLE)
      .upsert(orderToRow(o), { onConflict: "id" });
    if (error) throw new Error(`canton_swap_orders put: ${error.message}`);
  }

  async putIfStatus(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus
  ): Promise<boolean> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .update(orderToRow(o))
      .eq("id", o.id)
      .eq("status", expectedStatus)
      .select("id")
      .maybeSingle();
    if (error) {
      throw new Error(`canton_swap_orders putIfStatus: ${error.message}`);
    }
    return !!data;
  }

  async byStatus(status: CantonSwapStatus): Promise<CantonSwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("status", status);
    if (error) throw new Error(`canton_swap_orders byStatus: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }

  async byParty(party: string, limit = 50): Promise<CantonSwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("*")
      .eq("user_party", party)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`canton_swap_orders byParty: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }

  async sumReservedOut(
    solverParty: string,
    toAsset: CantonSwapOrder["toAsset"]
  ): Promise<string> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("out_amount")
      .eq("solver_party", solverParty)
      .eq("to_asset", toAsset)
      .in("status", ["settling", "filling", "user_locked"]);
    if (error) {
      throw new Error(`canton_swap_orders sumReservedOut: ${error.message}`);
    }
    const asset = getSwapAsset(toAsset);
    let total = 0n;
    for (const row of data ?? []) {
      total += toBaseUnitsFloor(String(row.out_amount ?? "0"), asset.decimals);
    }
    return fromBaseUnits(total, asset.decimals);
  }
}
