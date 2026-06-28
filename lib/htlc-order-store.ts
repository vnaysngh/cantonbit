/**
 * Supabase-backed HTLC order store (R5). Persists SwapOrders to htlc_orders so they
 * survive restarts (was an in-memory Map). Server-side only (service-role key).
 *
 * Maps the camelCase SwapOrder <-> snake_case htlc_orders row.
 */
import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";
import { assertUnifiedVaultReservationReady } from "./vault-reservation-readiness";
import type { SwapOrder, SwapStatus } from "./htlc-types";

const TABLE = "htlc_orders";

function rowToOrder(r: Record<string, unknown>): SwapOrder {
  return {
    id: r.id as string,
    direction: r.direction as SwapOrder["direction"],
    status: r.status as SwapStatus,
    evmChainSlug: (r.evm_chain_slug as string) ?? undefined,
    evmChainId:
      r.evm_chain_id == null ? undefined : Number(r.evm_chain_id as number),
    evmEscrowAddress: (r.evm_escrow_address as string) ?? undefined,
    evmWbtcAddress: (r.evm_wbtc_address as string) ?? undefined,
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
    solverCustodyBaselineCids: Array.isArray(r.solver_custody_baseline_cids)
      ? (r.solver_custody_baseline_cids as string[])
      : undefined,
    evmFloatReserved: Boolean(r.evm_float_reserved),
    networkFeeCc: (r.network_fee_cc as string) ?? undefined,
    networkFeeExpiresAt: r.network_fee_expires_at
      ? Math.floor(new Date(r.network_fee_expires_at as string).getTime() / 1000)
      : undefined,
    networkFeePreapprovalCid:
      (r.network_fee_preapproval_cid as string) ?? undefined,
    networkFeeSettlementUpdateId:
      (r.network_fee_settlement_update_id as string) ?? undefined,
    networkFeeAccountingPending: Boolean(r.network_fee_accounting_pending),
    createdAt: r.created_at ? Math.floor(new Date(r.created_at as string).getTime() / 1000) : 0,
    updatedAt: r.updated_at
      ? Math.floor(new Date(r.updated_at as string).getTime() / 1000)
      : undefined,
  };
}

function orderToRow(o: SwapOrder): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: o.id,
    direction: o.direction,
    status: o.status,
    evm_chain_slug: o.evmChainSlug ?? null,
    evm_chain_id: o.evmChainId ?? null,
    evm_escrow_address: o.evmEscrowAddress ?? null,
    evm_wbtc_address: o.evmWbtcAddress ?? null,
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
    solver_custody_baseline_cids: o.solverCustodyBaselineCids ?? null,
    evm_float_reserved: o.evmFloatReserved ?? false,
    updated_at: new Date().toISOString(),
  };

  // Network-fee columns are optional feature columns. Do not send null/false
  // placeholders when fees are disabled; otherwise older dev DBs or a stale
  // PostgREST schema cache reject order creation even though no fee is involved.
  if (o.networkFeeCc != null) row.network_fee_cc = o.networkFeeCc;
  if (o.networkFeeExpiresAt != null) {
    row.network_fee_expires_at = new Date(o.networkFeeExpiresAt * 1000).toISOString();
  }
  if (o.networkFeePreapprovalCid != null) {
    row.network_fee_preapproval_cid = o.networkFeePreapprovalCid;
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

export interface SwapStore {
  get(id: string): Promise<SwapOrder | undefined>;
  insert(o: SwapOrder): Promise<void>;
  /**
   * Compare-and-swap on status: persist `o` only if the row's CURRENT status still
   * equals `expectedStatus`. Returns true iff this call won (updated a row). Used as
   * an idempotency/concurrency gate before an irreversible action (e.g. a refund
   * transfer) so two concurrent sweeps can't both proceed.
   */
  putIfStatus(o: SwapOrder, expectedStatus: SwapStatus): Promise<boolean>;
  byStatus(s: SwapStatus): Promise<SwapOrder[]>;
  active(evmChainSlug?: string): Promise<SwapOrder[]>;
  /** Order history for one user party, newest first. */
  byParty(party: string, limit?: number): Promise<SwapOrder[]>;
  pendingNetworkFeeAccounting(): Promise<SwapOrder[]>;
  /** Atomically reserve forward CBTC float and transition open -> accepted. */
  acceptWithFloatReservation(
    orderId: string,
    solverCantonParty: string,
    floatSats: bigint
  ): Promise<{
    accepted: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedSats: bigint;
    needSats: bigint;
  }>;
  reserveReverseEvmFloat(
    orderId: string,
    floatUnits: bigint
  ): Promise<{
    reserved: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedUnits: bigint;
    needUnits: bigint;
  }>;
  /** All custody evidence CIDs ever linked to an order (including completed). */
  usedCounterTransferOfferCids(): Promise<Set<string>>;
  /** Reserve reverse WBTC before locking the user's Canton leg. */
  reserveReverseEvmFloatBeforeMainLock(
    orderId: string,
    floatUnits: bigint
  ): Promise<{
    reserved: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedUnits: bigint;
    needUnits: bigint;
  }>;
}

export class SupabaseSwapStore implements SwapStore {
  async get(id: string): Promise<SwapOrder | undefined> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`htlc_orders get: ${error.message}`);
    return data ? rowToOrder(data) : undefined;
  }
  async insert(o: SwapOrder): Promise<void> {
    const sb = await createSupabaseServiceClient();
    const { error } = await sb.from(TABLE).insert(orderToRow(o));
    if (error) {
      const err = new Error(`htlc_orders insert: ${error.message}`) as Error & {
        code?: string;
      };
      err.code = error.code;
      throw err;
    }
  }
  async putIfStatus(o: SwapOrder, expectedStatus: SwapStatus): Promise<boolean> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .update(orderToRow(o))
      .eq("id", o.id)
      .eq("status", expectedStatus)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`htlc_orders putIfStatus: ${error.message}`);
    return !!data; // a row matched the expected status → we won the CAS
  }
  async byStatus(s: SwapStatus): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.from(TABLE).select("*").eq("status", s);
    if (error) throw new Error(`htlc_orders byStatus: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }
  async acceptWithFloatReservation(
    orderId: string,
    solverCantonParty: string,
    floatSats: bigint
  ): Promise<{
    accepted: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedSats: bigint;
    needSats: bigint;
  }> {
    await assertUnifiedVaultReservationReady();
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc(
      "accept_htlc_order_with_float_reservation",
      {
        p_order_id: orderId,
        p_solver_canton_party: solverCantonParty,
        p_float_sats: floatSats.toString()
      }
    );
    if (error) {
      throw new Error(
        `htlc_orders acceptWithFloatReservation: ${error.message}`
      );
    }
    const result = (data ?? {}) as {
      accepted?: boolean;
      reason?: string;
      status?: SwapStatus;
      reservedSats?: string;
      needSats?: string;
    };
    return {
      accepted: result.accepted === true,
      reason: result.reason,
      status: result.status,
      reservedSats: BigInt(result.reservedSats ?? "0"),
      needSats: BigInt(result.needSats ?? "0")
    };
  }
  async reserveReverseEvmFloat(
    orderId: string,
    floatUnits: bigint
  ): Promise<{
    reserved: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedUnits: bigint;
    needUnits: bigint;
  }> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc("reserve_reverse_htlc_evm_float", {
      p_order_id: orderId,
      p_float_units: floatUnits.toString()
    });
    if (error) {
      throw new Error(`htlc_orders reserveReverseEvmFloat: ${error.message}`);
    }
    const result = (data ?? {}) as {
      reserved?: boolean;
      reason?: string;
      status?: SwapStatus;
      reservedUnits?: string;
      needUnits?: string;
    };
    return {
      reserved: result.reserved === true,
      reason: result.reason,
      status: result.status,
      reservedUnits: BigInt(result.reservedUnits ?? "0"),
      needUnits: BigInt(result.needUnits ?? "0")
    };
  }
  async reserveReverseEvmFloatBeforeMainLock(
    orderId: string,
    floatUnits: bigint
  ): Promise<{
    reserved: boolean;
    reason?: string;
    status?: SwapStatus;
    reservedUnits: bigint;
    needUnits: bigint;
  }> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb.rpc(
      "reserve_reverse_htlc_evm_float_before_main_lock",
      {
        p_order_id: orderId,
        p_float_units: floatUnits.toString()
      }
    );
    if (error) {
      throw new Error(
        `htlc_orders reserveReverseEvmFloatBeforeMainLock: ${error.message}`
      );
    }
    const result = (data ?? {}) as {
      reserved?: boolean;
      reason?: string;
      status?: SwapStatus;
      reservedUnits?: string;
      needUnits?: string;
    };
    return {
      reserved: result.reserved === true,
      reason: result.reason,
      status: result.status,
      reservedUnits: BigInt(result.reservedUnits ?? "0"),
      needUnits: BigInt(result.needUnits ?? "0")
    };
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
  async pendingNetworkFeeAccounting(): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("*")
      .eq("network_fee_accounting_pending", true);
    if (error) {
      throw new Error(`htlc_orders pendingNetworkFeeAccounting: ${error.message}`);
    }
    return (data ?? []).map(rowToOrder);
  }
  async active(evmChainSlug?: string): Promise<SwapOrder[]> {
    const sb = await createSupabaseServiceClient();
    let query = sb
      .from(TABLE)
      .select("*")
      .not("status", "in", "(main_claimed,refunded,cancelled,failed)");
    if (evmChainSlug) {
      query = query.eq("evm_chain_slug", evmChainSlug);
    }
    const { data, error } = await query;
    if (error) throw new Error(`htlc_orders active: ${error.message}`);
    return (data ?? []).map(rowToOrder);
  }
  async usedCounterTransferOfferCids(): Promise<Set<string>> {
    const sb = await createSupabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("counter_transfer_offer_cid")
      .not("counter_transfer_offer_cid", "is", null);
    if (error) {
      throw new Error(`htlc_orders usedCounterTransferOfferCids: ${error.message}`);
    }
    const used = new Set<string>();
    for (const row of data ?? []) {
      const cid = row.counter_transfer_offer_cid;
      if (typeof cid === "string" && cid) used.add(cid);
    }
    return used;
  }
}
