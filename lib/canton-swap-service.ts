import "server-only";

import { fromBaseUnits, toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset } from "./canton-assets";
import {
  assertOrderNotExpired,
  isLoopFillPendingCounterAccept,
  isLoopFillInFlight,
  isOrderExpired,
  isRetriableLoopFillError,
  counterReissueCooldownElapsed,
  LOOP_USER_LEG_OFFER_TTL_SECONDS,
  QUOTE_GRACE_SECONDS,
  resolveCreateCantonSwapOrder,
  shouldExpireForVaultMigration
} from "./canton-swap-order-logic";
import { QUOTE_TTL_SECONDS } from "./htlc-quote";
import { assertSettlementQuoteFresh, assertMvpOrderAmounts, quoteMvpCantonSwap } from "./canton-swap-quote";
import {
  computeC2cSwapNotionalUsd,
  estimateManagedC2cSettleFee,
  isNetworkFeeEnabled,
  networkFeeReceiverParty,
  revalidateOrderNetworkFee
} from "./canton-network-fee";
import { recordNetworkFeeCollected } from "./network-fee-ledger";
import {
  holdingsForSwapAsset
} from "./canton-swap-holdings";
import {
  fillLoopSwap,
  prepareLoopUserLeg,
  rejectUserLegOffer,
  reissueLoopCounterLeg,
  repairLoopFillFromLedger,
  repairManagedFillFromLedger,
  resolveUserLegEvidence,
  settleManagedSwap,
  listPendingOffersStrict,
  userReceivedCounterLeg,
  verifyCounterLegReceipt
} from "./canton-swap-settle";
import {
  SupabaseCantonSwapStore,
  type CantonSwapStore
} from "./canton-swap-store";
import type {
  CantonSwapMvpAssetId,
  CantonSwapOrder,
  CantonSwapStatus,
  CantonSwapWalletMode
} from "./canton-swap-types";
import { isCantonSwapActive } from "./canton-swap-types";
import { expectedCantonSwapParty } from "./htlc-auth";
import { swapParty } from "./canton-swap-types";
import { NETWORK } from "./constants";
import { randomUUID } from "crypto";

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const message = (err as { message?: string }).message ?? "";
  return message.includes("duplicate key") || message.includes("unique constraint");
}

export class CantonSwapService {
  constructor(private store: CantonSwapStore) {}

  async createOrder(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    walletMode: CantonSwapWalletMode;
    orderId?: string;
  }): Promise<CantonSwapOrder> {
    const vaultParty = expectedCantonSwapParty();
    if (!vaultParty) {
      throw new Error(
        "CANTON_SWAP_SETTLEMENT_PARTY not configured — required for C2C swaps"
      );
    }
    await assertMvpOrderAmounts(
      params.fromAsset,
      params.toAsset,
      params.inAmount,
      params.outAmount
    );
    const q = await quoteMvpCantonSwap(
      params.fromAsset,
      params.toAsset,
      params.inAmount
    );
    const to = getSwapAsset(params.toAsset);
    if (q.outUnits <= 0n) {
      throw new Error("quote output must be > 0");
    }
    const quotedOut = fromBaseUnits(q.outUnits, to.decimals);
    const claimedOut = params.outAmount;
    if (toBaseUnits(claimedOut, to.decimals) > q.outUnits) {
      throw new Error(
        `outAmount ${claimedOut} exceeds quote ${quotedOut}`
      );
    }

    const baseIncoming: Omit<CantonSwapOrder, "status" | "createdAt"> = {
      id: params.orderId ?? randomUUID(),
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      minOut: params.outAmount,
      quoteExpiresAt: q.expiresAt,
      userParty: params.userParty,
      solverParty: vaultParty,
      settlementParty: vaultParty,
      walletMode: params.walletMode
    };
    let incoming: Omit<CantonSwapOrder, "status" | "createdAt"> = baseIncoming;
    if (isNetworkFeeEnabled() && params.walletMode === "managed") {
      const notionalUsd = await computeC2cSwapNotionalUsd({
        fromAsset: params.fromAsset,
        inAmount: params.inAmount
      });
      const nf = await estimateManagedC2cSettleFee({
        userParty: params.userParty,
        vaultParty,
        fromAsset: params.fromAsset,
        toAsset: params.toAsset,
        inAmount: params.inAmount,
        outAmount: params.outAmount,
        notionalUsd
      });
      incoming = {
        ...baseIncoming,
        networkFeeCc: nf.feeCc,
        networkFeeExpiresAt: q.expiresAt
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (params.walletMode === "managed") {
      // Quote/fee work happens before persist — anchor expiry from write time, not RFQ start.
      incoming = {
        ...incoming,
        quoteExpiresAt: now + QUOTE_TTL_SECONDS + QUOTE_GRACE_SECONDS
      };
    }

    const existing = await this.store.get(incoming.id);
    const { order, isNew } = resolveCreateCantonSwapOrder(
      existing,
      incoming,
      now
    );
    if (!isNew) {
      if (!isCantonSwapActive(order)) {
        throw new Error("order no longer active — start a new swap");
      }
      return order;
    }
    await this.assertSwapFloat(
      incoming.solverParty,
      incoming.toAsset,
      incoming.outAmount
    );
    await this.store.put(order);
    return order;
  }

  /** Managed only: create intent + vault settle in one server request (no client race window). */
  async submitManaged(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    orderId?: string;
  }): Promise<CantonSwapOrder> {
    const order = await this.createOrder({ ...params, walletMode: "managed" });
    return this.settleManaged(order.id);
  }

  private async assertSwapFloat(
    vault: string,
    toAsset: CantonSwapMvpAssetId,
    outAmount: string
  ): Promise<void> {
    const counterHoldings = await holdingsForSwapAsset(vault, toAsset);
    const counterAsset = getSwapAsset(toAsset);
    const need = toBaseUnits(outAmount, counterAsset.decimals);
    let float = 0n;
    for (const h of counterHoldings) {
      const amt = h.payload?.amount ?? "0";
      float += toBaseUnitsFloor(String(amt), counterAsset.decimals);
    }

    const reservedStr = await this.store.sumReservedOut(vault, toAsset);
    const reserved = toBaseUnitsFloor(reservedStr, counterAsset.decimals);
    const available = float > reserved ? float - reserved : 0n;

    if (available < need) {
      throw new Error(
        `swap vault insufficient ${toAsset} float (need ${outAmount}, ${fromBaseUnits(available, counterAsset.decimals)} available after reservations)`
      );
    }
  }

  private async enforceSettlementQuote(o: CantonSwapOrder): Promise<void> {
    assertOrderNotExpired(o);
    await assertSettlementQuoteFresh({
      fromAsset: o.fromAsset,
      toAsset: o.toAsset,
      inAmount: o.inAmount,
      outAmount: o.outAmount,
      minOut: o.minOut
    });
  }

  /** CAS status transition — returns false if another worker won the race. */
  private async transition(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus
  ): Promise<boolean> {
    return this.store.putIfStatus(o, expectedStatus);
  }

  async get(id: string): Promise<CantonSwapOrder | undefined> {
    return this.store.get(id);
  }

  async must(id: string): Promise<CantonSwapOrder> {
    const o = await this.store.get(id);
    if (!o) throw new Error("swap not found");
    return o;
  }

  async settleManaged(id: string): Promise<CantonSwapOrder> {
    let o = await this.must(id);
    if (o.walletMode !== "managed") {
      throw new Error("settle is for managed users only");
    }
    if (o.status === "filled") return o;
    if (o.status === "settling") {
      return this.completeSettling(o);
    }
    if (o.status !== "open") {
      throw new Error(`cannot settle from status ${o.status}`);
    }

    await this.enforceSettlementQuote(o);
    await this.assertSwapFloat(swapParty(o), o.toAsset, o.outAmount);
    o.status = "settling";
    const moved = await this.transition(o, "open");
    if (!moved) {
      o = await this.must(id);
      if (o.status === "filled") return o;
      if (o.status === "settling") return this.completeSettling(o);
      throw new Error(`cannot settle from status ${o.status}`);
    }

    return this.completeSettling(o);
  }

  private async completeSettling(o: CantonSwapOrder): Promise<CantonSwapOrder> {
    let feeEstimate:
      | Awaited<ReturnType<typeof revalidateOrderNetworkFee>>
      | undefined;
    try {
      await this.enforceSettlementQuote(o);
      if (
        isNetworkFeeEnabled() &&
        o.networkFeeCc != null &&
        o.networkFeeCc !== ""
      ) {
        feeEstimate = await revalidateOrderNetworkFee(o);
        o.networkFeeCc = feeEstimate.feeCc;
        o.networkFeeExpiresAt = o.quoteExpiresAt;
        await this.store.put(o);
      }
      const result = await settleManagedSwap(o);
      if (result.networkFeeCollected && feeEstimate) {
        await recordNetworkFeeCollected({
          orderId: o.id,
          orderKind: "c2c",
          userParty: o.userParty,
          feeCc: result.networkFeeCollected.feeCc,
          feeUsd: feeEstimate.feeUsd,
          trafficBytes: feeEstimate.trafficBytes,
          networkFeeSource: feeEstimate.networkFeeSource,
          receiverParty: networkFeeReceiverParty(),
          settlementUpdateId: result.updateId
        });
      }
      this.applyManagedFillResult(o, result);
      if (!(await this.transition(o, "settling"))) {
        const fresh = await this.must(o.id);
        if (fresh.status === "filled") return fresh;
        if (o.status === "filled") {
          await this.store.put(o);
          return o;
        }
      }
      return o;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const repaired = await this.repairManagedFromLedger(o);
      if (repaired) return repaired;
      if (
        msg.includes("duplicate command committed but settle transaction not found")
      ) {
        return this.must(o.id);
      }
      if (msg.includes("submission in flight")) {
        o.status = "settling";
        o.failureReason = "Settle still processing on ledger — retry shortly";
        await this.store.put(o);
        throw e;
      }
      o.status = "failed";
      o.failureReason = msg;
      await this.transition(o, "settling");
      throw e;
    }
  }

  /** Ledger committed fill but DB shows failed/settling (e.g. duplicate settle race). */
  async repairManagedFromLedger(o: CantonSwapOrder): Promise<CantonSwapOrder | null> {
    if (o.walletMode !== "managed") return null;
    const result = await repairManagedFillFromLedger(o);
    if (!result) return null;
    const priorStatus = o.status;
    this.applyManagedFillResult(o, result);
    if (!(await this.transition(o, priorStatus))) {
      await this.store.put(o);
    }
    return o;
  }

  async prepareUserLeg(id: string): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
    transferKind: string;
    counterRequiresAccept: boolean;
  }> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("prepare-user-leg is loop only");
    if (o.status !== "open") throw new Error(`invalid status ${o.status}`);
    assertOrderNotExpired(o);
    return prepareLoopUserLeg(o);
  }

  async confirmUserLeg(
    id: string,
    params?: { offerCid?: string; submitUpdateId?: string }
  ): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("confirm-user-leg is loop only");
    if (o.status === "user_locked") return o;
    if (o.status !== "open") throw new Error(`invalid status ${o.status}`);
    assertOrderNotExpired(o);
    const reservedCids = await this.reservedUserLegCids(id);
    const resolved = await resolveUserLegEvidence(o, {
      maxAttempts: 10,
      pollMs: 1500,
      reservedCids,
      offerCidHint: params?.offerCid,
      submitUpdateId: params?.submitUpdateId
    });
    await this.assertSwapFloat(swapParty(o), o.toAsset, o.outAmount);
    o.userLegOfferCid = resolved.userLegOfferCid;
    o.userLegSubmitUpdateId = resolved.userLegSubmitUpdateId ?? params?.submitUpdateId;
    o.status = "user_locked";
    try {
      if (!(await this.transition(o, "open"))) {
        const fresh = await this.must(id);
        if (fresh.status === "user_locked") {
          return fresh;
        }
        throw new Error(`cannot confirm user leg from status ${fresh.status}`);
      }
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        throw new Error("user leg offer already reserved by another order");
      }
      throw e;
    }
    return o;
  }

  private async reservedUserLegCids(excludeOrderId: string): Promise<Set<string>> {
    const active = await this.store.byStatus("user_locked");
    const openLoop = await this.store.byStatus("open");
    const cids = new Set<string>();
    for (const row of [...active, ...openLoop]) {
      if (row.id === excludeOrderId) continue;
      if (row.walletMode !== "loop") continue;
      if (row.userLegOfferCid) cids.add(row.userLegOfferCid);
    }
    return cids;
  }

  async fillLoop(id: string): Promise<CantonSwapOrder> {
    let o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("fill is loop only");
    if (o.status === "filled") return o;
    if (o.status === "filling") {
      o = await this.must(id);
      if (o.status === "filled") return o;
      if (isLoopFillPendingCounterAccept(o)) return o;
    }
    if (o.status !== "user_locked" && o.status !== "filling") {
      throw new Error(`cannot fill from status ${o.status}`);
    }
    if (isLoopFillPendingCounterAccept(o)) {
      return o;
    }
    await this.enforceSettlementQuote(o);
    await this.assertSwapFloat(swapParty(o), o.toAsset, o.outAmount);

    if (o.status === "user_locked") {
      o.status = "filling";
      if (!(await this.transition(o, "user_locked"))) {
        o = await this.must(id);
        if (o.status === "filled") return o;
        if (isLoopFillPendingCounterAccept(o)) return o;
        if (o.status === "filling") {
          // another worker is filling — exit without double-submit
          return o;
        }
        throw new Error(`cannot fill from status ${o.status}`);
      }
    }

    if (o.status === "filling") {
      const repaired = await repairLoopFillFromLedger(o);
      if (repaired) {
        this.applyLoopFillResult(o, repaired);
        if (!(await this.transition(o, "filling"))) {
          return this.must(id);
        }
        return o;
      }
    }

    try {
      const result = await fillLoopSwap(o);
      this.applyLoopFillResult(o, result);
      if (!(await this.transition(o, "filling"))) {
        return this.must(id);
      }
      return o;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("submission in flight")) {
        o = await this.must(id);
        if (o.status === "filling") return o;
        o.status = "user_locked";
        o.failureReason = "Fill still processing on ledger — retry shortly";
        await this.transition(o, "filling");
        return this.must(id);
      }
      if (
        msg.includes("duplicate command committed but fill transaction not found")
      ) {
        return this.must(id);
      }
      if (isRetriableLoopFillError(msg)) {
        o.status = "user_locked";
        o.failureReason = msg;
        await this.transition(o, "filling");
        return this.must(id);
      }
      o.status = "failed";
      o.failureReason = msg;
      await this.transition(o, "filling");
      throw e;
    }
  }

  private applyLoopFillResult(
    o: CantonSwapOrder,
    result: {
      updateId: string;
      counterLegOfferCid?: string;
      counterLegPendingAccept: boolean;
    }
  ): void {
    if (!result.updateId) {
      throw new Error("fill result missing settlement update id");
    }
    o.settlementUpdateId = result.updateId;
    o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
    o.counterPendingClearedAt = undefined;
    o.status = result.counterLegPendingAccept ? "user_locked" : "filled";
    if (result.counterLegPendingAccept) {
      o.failureReason =
        "Counter leg pending Loop accept — user must accept incoming transfer";
    } else {
      o.failureReason = undefined;
    }
  }

  private applyManagedFillResult(
    o: CantonSwapOrder,
    result: {
      updateId: string;
      counterLegOfferCid?: string;
      counterLegPendingAccept: boolean;
    }
  ): void {
    if (!result.updateId) {
      throw new Error("settle result missing settlement update id");
    }
    o.settlementUpdateId = result.updateId;
    o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
    if (result.counterLegPendingAccept) {
      o.status = "settling";
      o.failureReason =
        "Counter leg pending accept — accept incoming transfer to complete swap";
    } else {
      o.status = "filled";
      o.failureReason = undefined;
    }
  }

  /** Retry Loop orders stuck in filling after crash between ledger submit and DB update. */
  async reconcileFilling(): Promise<number> {
    const orders = await this.store.byStatus("filling");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "loop") continue;
      try {
        const repaired = await repairLoopFillFromLedger(o);
        if (repaired) {
          this.applyLoopFillResult(o, repaired);
          if (await this.transition(o, "filling")) {
            n++;
          }
          continue;
        }
        await this.fillLoop(o.id);
        n++;
      } catch {
        // leave for next tick
      }
    }
    return n;
  }

  /** Repair failed Loop fills from ledger or reset for daemon retry. */
  async reconcileFailedLoop(): Promise<number> {
    const orders = await this.store.byStatus("failed");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "loop") continue;
      if (isOrderExpired(o)) continue;
      try {
        const repaired = await repairLoopFillFromLedger(o);
        if (repaired) {
          this.applyLoopFillResult(o, repaired);
          if (await this.transition(o, "failed")) {
            n++;
          }
          continue;
        }
        if (!o.userLegOfferCid) continue;
        o.status = "user_locked";
        o.failureReason = "Retrying after transient fill failure";
        if (await this.transition(o, "failed")) {
          n++;
        }
      } catch {
        // leave for next tick
      }
    }
    return n;
  }

  /** Repair managed orders when ledger committed but DB is settling/failed. */
  async reconcileSettling(): Promise<number> {
    let n = 0;
    for (const status of ["settling", "failed"] as const) {
      const orders = await this.store.byStatus(status);
      for (const o of orders) {
        if (o.walletMode !== "managed") continue;
        try {
          const repaired = await this.repairManagedFromLedger(o);
          if (repaired) {
            n++;
            continue;
          }
          if (
            o.status === "settling" &&
            o.settlementUpdateId &&
            o.counterLegOfferCid &&
            (await userReceivedCounterLeg(o))
          ) {
            o.status = "filled";
            o.failureReason = undefined;
            if (await this.transition(o, "settling")) {
              n++;
            }
          }
        } catch {
          // leave for next tick
        }
      }
    }
    return n;
  }

  /** Re-issue expired counter offers after the user sell leg was already taken. */
  async reconcileLoopCounters(): Promise<number> {
    const orders = await this.store.byStatus("user_locked");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "loop") continue;
      if (!o.settlementUpdateId || !o.counterLegOfferCid) continue;

      const pending = await listPendingOffersStrict(o.userParty);
      if (pending.some((p) => p.contractId === o.counterLegOfferCid)) {
        if (o.counterPendingClearedAt !== undefined) {
          o.counterPendingClearedAt = undefined;
          await this.store.put(o);
        }
        continue;
      }

      const receipt = await verifyCounterLegReceipt(o, {
        maxAttempts: 8,
        pollMs: 1500
      });
      if (receipt === "received") {
        o.status = "filled";
        o.failureReason = undefined;
        o.counterPendingClearedAt = undefined;
        if (await this.transition(o, "user_locked")) {
          n++;
        }
        continue;
      }
      if (receipt === "pending") {
        if (o.counterPendingClearedAt !== undefined) {
          o.counterPendingClearedAt = undefined;
          await this.store.put(o);
        }
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      if (!o.counterPendingClearedAt) {
        o.counterPendingClearedAt = now;
        o.failureReason =
          "Verifying counter accept on ledger — wait before reissue";
        await this.store.put(o);
        continue;
      }
      if (!counterReissueCooldownElapsed(o.counterPendingClearedAt, now)) {
        continue;
      }

      const priorOfferCid = o.counterLegOfferCid;
      const priorAttempt = o.counterReissueAttempt ?? 0;
      const fresh = await this.must(o.id);
      if (
        fresh.counterLegOfferCid !== priorOfferCid ||
        (fresh.counterReissueAttempt ?? 0) !== priorAttempt
      ) {
        continue;
      }

      const recheck = await verifyCounterLegReceipt(fresh, {
        maxAttempts: 4,
        pollMs: 1000
      });
      if (recheck === "received") {
        fresh.status = "filled";
        fresh.failureReason = undefined;
        fresh.counterPendingClearedAt = undefined;
        if (await this.transition(fresh, "user_locked")) {
          n++;
        }
        continue;
      }
      if (recheck === "pending") {
        fresh.counterPendingClearedAt = undefined;
        await this.store.put(fresh);
        continue;
      }

      console.warn(
        `[canton-swap] COUNTER REISSUE order=${fresh.id.slice(0, 12)}… ` +
          `priorCid=${priorOfferCid.slice(0, 16)}… attempt=${priorAttempt + 1} ` +
          `settlement=${fresh.settlementUpdateId?.slice(0, 16)}…`
      );

      try {
        const result = await reissueLoopCounterLeg(fresh);
        fresh.counterReissueAttempt = result.counterReissueAttempt;
        fresh.counterLegOfferCid = result.counterLegOfferCid ?? fresh.counterLegOfferCid;
        fresh.counterPendingClearedAt = undefined;
        if (result.counterLegPendingAccept) {
          fresh.failureReason =
            "Counter leg pending Loop accept — user must accept incoming transfer";
        } else {
          fresh.status = "filled";
          fresh.failureReason = undefined;
          fresh.counterLegOfferCid = result.counterLegOfferCid;
        }
        if (
          await this.store.putIfStatusAndCounterOffer(
            fresh,
            "user_locked",
            priorOfferCid
          )
        ) {
          n++;
        }
      } catch (e) {
        console.warn(
          `[canton-swap] counter reissue failed ${fresh.id.slice(0, 12)}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
    return n;
  }

  async expireStale(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const vaultParty = expectedCantonSwapParty();
    let n = 0;
    for (const status of ["open", "user_locked", "settling", "filling"] as const) {
      const orders = await this.store.byStatus(status);
      for (const o of orders) {
        if (shouldExpireForVaultMigration(o, vaultParty, now)) {
          try {
            if (
              o.walletMode === "loop" &&
              o.userLegOfferCid &&
              !o.settlementUpdateId
            ) {
              await rejectUserLegOffer(o);
            }
          } catch (e) {
            console.warn(
              `[canton-swap] reject on vault migration failed ${o.id.slice(0, 12)}:`,
              e instanceof Error ? e.message : e
            );
          }
          const priorStatus = o.status;
          o.status = "expired";
          o.failureReason = "order superseded — settlement vault migration";
          if (await this.transition(o, priorStatus)) {
            n++;
          }
          continue;
        }
        if (isLoopFillPendingCounterAccept(o)) continue;
        if (isLoopFillInFlight(o)) continue;
        if (!isOrderExpired(o, now)) continue;

        const priorStatus = o.status;

        if (
          o.walletMode === "managed" &&
          (priorStatus === "open" || priorStatus === "settling")
        ) {
          try {
            const repaired = await this.repairManagedFromLedger(o);
            if (repaired?.status === "filled") {
              n++;
              continue;
            }
          } catch {
            // fall through to expire
          }
        }

        if (
          priorStatus === "filling" &&
          o.walletMode === "loop" &&
          !o.settlementUpdateId
        ) {
          try {
            const repaired = await repairLoopFillFromLedger(o);
            if (repaired) {
              this.applyLoopFillResult(o, repaired);
              if (await this.transition(o, "filling")) {
                n++;
              }
              continue;
            }
          } catch (e) {
            console.warn(
              `[canton-swap] fill repair on expire failed ${o.id.slice(0, 12)}:`,
              e instanceof Error ? e.message : e
            );
          }
        }

        try {
          if (
            (priorStatus === "user_locked" || priorStatus === "filling") &&
            o.walletMode === "loop" &&
            o.userLegOfferCid &&
            !o.settlementUpdateId
          ) {
            await rejectUserLegOffer(o);
          }
        } catch (e) {
          console.warn(
            `[canton-swap] reject on expire failed ${o.id.slice(0, 12)}:`,
            e instanceof Error ? e.message : e
          );
        }

        o.status = "expired";
        o.failureReason =
          o.walletMode === "loop" ? "order expired" : "quote expired";
        if (await this.transition(o, priorStatus)) {
          n++;
        }
      }
    }
    return n;
  }

  async cancel(id: string): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.status !== "open") {
      throw new Error(`cannot cancel from status ${o.status}`);
    }
    o.status = "cancelled";
    o.failureReason = undefined;
    if (!(await this.transition(o, "open"))) {
      const fresh = await this.must(id);
      if (fresh.status === "cancelled") return fresh;
      throw new Error(`cannot cancel from status ${fresh.status}`);
    }
    return o;
  }

  /** Repair managed rows when ledger fill committed but DB stuck (expired/settling/failed/open). */
  async reconcileExpiredManaged(): Promise<number> {
    let n = 0;
    for (const status of ["expired", "open", "settling", "failed"] as const) {
      const orders = await this.store.byStatus(status);
      for (const o of orders) {
        if (o.walletMode !== "managed") continue;
        try {
          const repaired = await this.repairManagedFromLedger(o);
          if (repaired?.status === "filled") n++;
        } catch {
          // leave for next tick
        }
      }
    }
    return n;
  }

  async history(party: string, limit = 50): Promise<CantonSwapOrder[]> {
    const orders = await this.store.byParty(party, limit);
    const out: CantonSwapOrder[] = [];
    for (const o of orders) {
      if (
        o.walletMode === "managed" &&
        (o.status === "failed" ||
          o.status === "expired" ||
          o.status === "settling" ||
          o.status === "open")
      ) {
        const repaired = await this.repairManagedFromLedger(o);
        out.push(repaired ?? o);
      } else {
        out.push(o);
      }
    }
    return out;
  }

  async markCounterAccepted(id: string): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.walletMode === "loop") {
      if (o.status !== "user_locked") {
        throw new Error(`invalid status ${o.status}`);
      }
    } else if (o.walletMode === "managed") {
      if (o.status !== "settling") {
        throw new Error(`invalid status ${o.status}`);
      }
    } else {
      throw new Error("counter accept is loop or managed only");
    }
    if (!o.counterLegOfferCid) {
      throw new Error("no counter leg offer on order");
    }
    if (!o.settlementUpdateId) {
      throw new Error("solver fill not completed yet");
    }

    const pending = await listPendingOffersStrict(o.userParty);
    if (pending.some((p) => p.contractId === o.counterLegOfferCid)) {
      throw new Error(
        "Counter leg not accepted yet — complete the Loop accept first"
      );
    }

    if (!(await userReceivedCounterLeg(o))) {
      throw new Error(
        "Counter leg accept not verified — complete Loop accept or wait for settlement"
      );
    }

    o.status = "filled";
    o.failureReason = undefined;
    const priorStatus = o.walletMode === "loop" ? "user_locked" : "settling";
    if (!(await this.transition(o, priorStatus))) {
      const fresh = await this.must(id);
      if (fresh.status === "filled") return fresh;
      throw new Error(`cannot mark filled from status ${fresh.status}`);
    }
    return o;
  }

  async listByStatus(status: CantonSwapOrder["status"]): Promise<CantonSwapOrder[]> {
    return this.store.byStatus(status);
  }
}

let _svc: CantonSwapService | undefined;
export function cantonSwapService(): CantonSwapService {
  if (!_svc) {
    if (!NETWORK?.decentralizedPartyId) {
      throw new Error("NETWORK not configured");
    }
    _svc = new CantonSwapService(new SupabaseCantonSwapStore());
  }
  return _svc;
}
