import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";

const TABLE = "network_fee_ledger";

export class NetworkFeeLedgerLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFeeLedgerLookupError";
  }
}

export interface NetworkFeeLedgerEntry {
  orderId: string;
  orderKind: "c2c" | "htlc";
  userParty: string;
  feeCc: string;
  feeUsd?: number;
  trafficBytes?: number;
  networkFeeSource: string;
  receiverParty: string;
  settlementUpdateId?: string;
}

export class NetworkFeeSettlementReusedError extends Error {
  constructor(updateId: string) {
    super(
      `settlement update ${updateId.slice(0, 16)}… already recorded for another order — replay rejected`
    );
    this.name = "NetworkFeeSettlementReusedError";
  }
}

/** Idempotent per (order_id, order_kind). H-01: a settlement_update_id is also
 *  globally unique (migration 027), so reusing one valid fee update across orders
 *  is rejected as a replay rather than silently double-counted. */
export async function recordNetworkFeeCollected(
  entry: NetworkFeeLedgerEntry
): Promise<void> {
  const sb = await createSupabaseServiceClient();
  // Coerce empty/whitespace settlement ids to NULL: "" is NOT a real update id and
  // would collide under the partial unique index (which only excludes NULL).
  const settlementUpdateId = entry.settlementUpdateId?.trim() || null;
  const { error } = await sb.from(TABLE).upsert(
    {
      order_id: entry.orderId,
      order_kind: entry.orderKind,
      user_party: entry.userParty,
      fee_cc: entry.feeCc,
      fee_usd: entry.feeUsd ?? null,
      traffic_bytes: entry.trafficBytes ?? null,
      network_fee_source: entry.networkFeeSource,
      receiver_party: entry.receiverParty,
      settlement_update_id: settlementUpdateId
    },
    { onConflict: "order_id,order_kind", ignoreDuplicates: false }
  );
  if (!error) return;
  // The settlement-update unique index fired → this update was already used by a
  // different order. Surface it as a replay, not a swallowed "duplicate".
  if (
    error.message.includes("network_fee_ledger_settlement_update_uidx") ||
    error.message.includes("settlement_update_id")
  ) {
    throw new NetworkFeeSettlementReusedError(entry.settlementUpdateId ?? "");
  }
  // The (order_id, order_kind) idempotency conflict is expected on retries.
  if (!error.message.includes("duplicate")) {
    throw new Error(`network fee ledger upsert failed: ${error.message}`);
  }
}

/** Post-commit accounting — never wedge swap state if Supabase is down. */
export async function bestEffortRecordNetworkFeeCollected(
  entry: NetworkFeeLedgerEntry
): Promise<void> {
  try {
    await recordNetworkFeeCollected(entry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[network-fee-ledger] deferred write: ${msg.slice(0, 120)}`);
  }
}

export async function hasNetworkFeeLedgerEntry(
  orderId: string,
  orderKind: "c2c" | "htlc"
): Promise<boolean> {
  const sb = await createSupabaseServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("order_id")
    .eq("order_id", orderId)
    .eq("order_kind", orderKind)
    .maybeSingle();
  if (error) {
    console.warn(`[network-fee-ledger] lookup failed: ${error.message}`);
    throw new NetworkFeeLedgerLookupError(error.message);
  }
  return !!data;
}

/** Batch fee-collected lookup for history list views (one query vs N). */
export async function networkFeeLedgerEntrySet(
  orderIds: string[],
  orderKind: "c2c" | "htlc"
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const sb = await createSupabaseServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("order_id")
    .eq("order_kind", orderKind)
    .in("order_id", orderIds);
  if (error) {
    console.warn(`[network-fee-ledger] batch lookup failed: ${error.message}`);
    throw new NetworkFeeLedgerLookupError(error.message);
  }
  return new Set((data ?? []).map((row) => String(row.order_id)));
}
