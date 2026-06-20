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

/** Idempotent — one row per (order_id, order_kind). */
export async function recordNetworkFeeCollected(
  entry: NetworkFeeLedgerEntry
): Promise<void> {
  const sb = await createSupabaseServiceClient();
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
      settlement_update_id: entry.settlementUpdateId ?? null
    },
    { onConflict: "order_id,order_kind", ignoreDuplicates: false }
  );
  if (error && !error.message.includes("duplicate")) {
    throw new Error(`network fee ledger upsert failed: ${error.message}`);
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
