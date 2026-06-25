import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";
import type {
  CantonSwapOrder,
  CantonSwapStatus,
  CantonSwapWalletMode
} from "./canton-swap-types";

const TABLE = "canton_swap_orders";

function enrichSchemaError(op: string, message: string): string {
  if (
    message.includes("schema cache") ||
    message.includes("counter_pending_cleared_at") ||
    message.includes("counter_reissue_attempt") ||
    message.includes("network_fee_cc")
  ) {
    return (
      `${TABLE} ${op}: database schema out of date — apply Supabase migrations ` +
      `018–023 in supabase/migrations/ (missing column/index). Original: ${message}`
    );
  }
  return `${TABLE} ${op}: ${message}`;
}

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
    settlementParty: (r.settlement_party as string) ?? undefined,
    walletMode: r.wallet_mode as CantonSwapWalletMode,
    floatReserved: Boolean(r.float_reserved),
    userLegOfferCid: (r.user_leg_offer_cid as string) ?? undefined,
    userLegSubmitUpdateId: (r.user_leg_submit_update_id as string) ?? undefined,
    counterLegOfferCid: (r.counter_leg_offer_cid as string) ?? undefined,
    counterLegCreatedOffset:
      r.counter_leg_created_offset == null
        ? undefined
        : Number(r.counter_leg_created_offset),
    counterReceiptUpdateId:
      (r.counter_receipt_update_id as string) ?? undefined,
    settlementUpdateId: (r.settlement_update_id as string) ?? undefined,
    counterReissueAttempt: Number(r.counter_reissue_attempt ?? 0),
    counterPendingClearedAt: r.counter_pending_cleared_at
      ? Math.floor(new Date(r.counter_pending_cleared_at as string).getTime() / 1000)
      : undefined,
    failureReason: (r.failure_reason as string) ?? undefined,
    networkFeeCc: (r.network_fee_cc as string) ?? undefined,
    networkFeeExpiresAt: r.network_fee_expires_at
      ? Math.floor(new Date(r.network_fee_expires_at as string).getTime() / 1000)
      : undefined,
    networkFeeSettlementUpdateId:
      (r.network_fee_settlement_update_id as string) ?? undefined,
    networkFeeAccountingPending: Boolean(r.network_fee_accounting_pending),
    createdAt: r.created_at
      ? Math.floor(new Date(r.created_at as string).getTime() / 1000)
      : 0
  };
}

function orderToRow(o: CantonSwapOrder): Record<string, unknown> {
  const row: Record<string, unknown> = {
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
    settlement_party: o.settlementParty ?? null,
    wallet_mode: o.walletMode,
    float_reserved: o.floatReserved ?? false,
    user_leg_offer_cid: o.userLegOfferCid ?? null,
    user_leg_submit_update_id: o.userLegSubmitUpdateId ?? null,
    counter_leg_offer_cid: o.counterLegOfferCid ?? null,
    counter_leg_created_offset: o.counterLegCreatedOffset ?? null,
    counter_receipt_update_id: o.counterReceiptUpdateId ?? null,
    settlement_update_id: o.settlementUpdateId ?? null,
    counter_reissue_attempt: o.counterReissueAttempt ?? 0,
    counter_pending_cleared_at: o.counterPendingClearedAt
      ? new Date(o.counterPendingClearedAt * 1000).toISOString()
      : null,
    failure_reason: o.failureReason ?? null,
    ...(o.createdAt > 0
      ? { created_at: new Date(o.createdAt * 1000).toISOString() }
      : {}),
    updated_at: new Date().toISOString()
  };

  // Network-fee columns are optional feature columns. Avoid sending null/false
  // placeholders when fees are disabled so local/dev DBs without those columns
  // can still create and settle no-fee orders.
  if (o.networkFeeCc != null) row.network_fee_cc = o.networkFeeCc;
  if (o.networkFeeExpiresAt != null) {
    row.network_fee_expires_at = new Date(o.networkFeeExpiresAt * 1000).toISOString();
  }
  if (o.networkFeeSettlementUpdateId != null) {
    row.network_fee_settlement_update_id = o.networkFeeSettlementUpdateId;
  }
  if (
    o.networkFeeAccountingPending === true ||
    o.networkFeeSettlementUpdateId != null
  ) {
    row.network_fee_accounting_pending = o.networkFeeAccountingPending ?? false;
  }

  return row;
}

export interface CantonSwapStore {
  get(id: string): Promise<CantonSwapOrder | undefined>;
  /** First-write-wins order creation. */
  insert(o: CantonSwapOrder): Promise<void>;
  /** Optimistic status transition — returns false if status changed concurrently. */
  putIfStatus(o: CantonSwapOrder, expectedStatus: CantonSwapStatus): Promise<boolean>;
  /** Status + counter offer CAS — prevents concurrent counter reissues. */
  putIfStatusAndCounterOffer(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus,
    expectedCounterLegOfferCid: string | null
  ): Promise<boolean>;
  byStatus(status: CantonSwapStatus): Promise<CantonSwapOrder[]>;
  /** All user-leg offer CIDs ever linked (including completed). */
  usedUserLegOfferCids(): Promise<Set<string>>;
  byParty(party: string, limit?: number): Promise<CantonSwapOrder[]>;
  pendingNetworkFeeAccounting(): Promise<CantonSwapOrder[]>;
  /** Atomically reserve current vault float and transition the order. */
  reserveFloat(params: {
    orderId: string;
    expectedStatus: CantonSwapStatus;
    nextStatus: CantonSwapStatus;
    floatUnits: bigint;
    userLegOfferCid?: string;
    userLegSubmitUpdateId?: string;
  }): Promise<{ reservedUnits: bigint; needUnits: bigint }>;
}

export class SupabaseCantonSwapStore implements CantonSwapStore {
  async get(id: string): Promise<CantonSwapOrder | undefined> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(enrichSchemaError("get", error.message));
    return data ? rowToOrder(data) : undefined;
  }

  async insert(o: CantonSwapOrder): Promise<void> {
    const sb = await createSupabaseServiceClient();
    const { error } = await sb.from(TABLE).insert(orderToRow(o));
    if (error) {
      const err = new Error(enrichSchemaError("insert", error.message)) as Error & {
        code?: string;
      };
      err.code = error.code;
      throw err;
    }
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
      const err = new Error(
        `canton_swap_orders putIfStatus: ${error.message}`
      ) as Error & { code?: string };
      err.code = error.code;
      throw err;
    }
    return !!data;
  }

  async putIfStatusAndCounterOffer(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus,
    expectedCounterLegOfferCid: string | null
  ): Promise<boolean> {
    const sb = await createSupabaseServiceClient();
    let query = sb
      .from(TABLE)
      .update(orderToRow(o))
      .eq("id", o.id)
      .eq("status", expectedStatus);
    if (expectedCounterLegOfferCid === null) {
      query = query.is("counter_leg_offer_cid", null);
    } else {
      query = query.eq("counter_leg_offer_cid", expectedCounterLegOfferCid);
    }
    const { data, error } = await query.select("id").maybeSingle();
    if (error) {
      const err = new Error(
        `canton_swap_orders putIfStatusAndCounterOffer: ${error.message}`
      ) as Error & { code?: string };
      err.code = error.code;
      throw err;
    }
    return !!data;
  }

  async byStatus(status: CantonSwapStatus): Promise<CantonSwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("status", status);
    if (error) throw new Error(enrichSchemaError("byStatus", error.message));
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
    if (error) throw new Error(enrichSchemaError("byParty", error.message));
    return (data ?? []).map(rowToOrder);
  }

  async pendingNetworkFeeAccounting(): Promise<CantonSwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("*")
      .eq("network_fee_accounting_pending", true);
    if (error) {
      throw new Error(enrichSchemaError("pendingNetworkFeeAccounting", error.message));
    }
    return (data ?? []).map(rowToOrder);
  }

  async reserveFloat(params: {
    orderId: string;
    expectedStatus: CantonSwapStatus;
    nextStatus: CantonSwapStatus;
    floatUnits: bigint;
    userLegOfferCid?: string;
    userLegSubmitUpdateId?: string;
  }): Promise<{ reservedUnits: bigint; needUnits: bigint }> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc("reserve_canton_swap_float", {
      p_order_id: params.orderId,
      p_expected_status: params.expectedStatus,
      p_next_status: params.nextStatus,
      p_float_units: params.floatUnits.toString(),
      p_user_leg_offer_cid: params.userLegOfferCid ?? null,
      p_user_leg_submit_update_id: params.userLegSubmitUpdateId ?? null
    });
    if (error) {
      const err = new Error(enrichSchemaError("reserveFloat", error.message)) as Error & {
        code?: string;
      };
      err.code = error.code;
      throw err;
    }
    const result = data as {
      reserved?: boolean;
      reason?: string;
      status?: string;
      reservedUnits?: string;
      needUnits?: string;
      availableUnits?: string;
    } | null;
    if (!result?.reserved) {
      if (result?.reason === "insufficient_float") {
        throw new Error(
          `swap vault insufficient float (need ${result.needUnits ?? "?"} units, ` +
            `${result.availableUnits ?? "0"} available after reservations)`
        );
      }
      throw new Error(
        `could not reserve swap float (${result?.reason ?? "unknown"}, status ${result?.status ?? "unknown"})`
      );
    }
    return {
      reservedUnits: BigInt(result.reservedUnits ?? "0"),
      needUnits: BigInt(result.needUnits ?? "0")
    };
  }

  async usedUserLegOfferCids(): Promise<Set<string>> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("user_leg_offer_cid")
      .not("user_leg_offer_cid", "is", null);
    if (error) {
      throw new Error(enrichSchemaError("usedUserLegOfferCids", error.message));
    }
    const used = new Set<string>();
    for (const row of data ?? []) {
      const cid = row.user_leg_offer_cid;
      if (typeof cid === "string" && cid) used.add(cid);
    }
    return used;
  }
}
