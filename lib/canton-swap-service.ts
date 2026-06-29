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
  QUOTE_GRACE_SECONDS,
  resolveCreateCantonSwapOrder,
  isFalseVaultMigrationExpire,
  shouldExpireForVaultMigration
} from "./canton-swap-order-logic";
import { QUOTE_TTL_SECONDS } from "./htlc-quote";
import { assertSettlementQuoteFresh, assertMvpOrderAmounts, quoteMvpCantonSwap, settlementMinOutAmount } from "./canton-swap-quote";
import {
  computeC2cSwapNotionalUsd,
  estimateManagedC2cSettleFee,
  isNetworkFeeEnabled,
  networkFeeReceiverParty,
  revalidateOrderNetworkFee
} from "./canton-network-fee";
import {
  recordNetworkFeeCollected
} from "./network-fee-ledger";
import {
  holdingsForSwapAsset
} from "./canton-swap-holdings";
import {
  fillLoopSwap,
  ensureManagedUserLegOffer,
  prepareLoopUserLeg,
  prepareLoopUserLegWithCids,
  rejectUserLegOffer,
  reissueLoopCounterLeg,
  repairLoopFillFromLedger,
  repairLoopFillFromSettlement,
  repairManagedFillFromLedger,
  resolveUserLegEvidence,
  proveCounterDeliveredOnSettlement,
  settleManagedSwap,
  listPendingOffersStrict,
  verifyCounterLegReceiptProof
} from "./canton-swap-settle";
import { formatSettlementError } from "./swap-settlement-messages";
import { c2cCounterLegProofPresent } from "./swap-product-invariants";
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
import { assertSwapPayAmountLimit } from "./swap-amount-limits";
import {
  assertValidPrepareCreatedAt,
  issuePrepareCreatedAt
} from "./swap-prepare-intent";
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
    /** Server-validated prepare timestamp — do not pass from raw client input. */
    createdAt?: number;
  }): Promise<CantonSwapOrder> {
    const vaultParty = expectedCantonSwapParty();
    if (!vaultParty) {
      throw new Error(
        "CANTON_SWAP_SETTLEMENT_PARTY not configured — required for C2C swaps"
      );
    }
    assertSwapPayAmountLimit(params.fromAsset, params.inAmount);
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
      minOut: settlementMinOutAmount(params.outAmount, to.decimals),
      quoteExpiresAt: q.expiresAt,
      userParty: params.userParty,
      solverParty: vaultParty,
      settlementParty: vaultParty,
      walletMode: params.walletMode,
      floatReserved: false
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

    const now = params.createdAt ?? Math.floor(Date.now() / 1000);
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
    try {
      await this.store.insert(order);
      return order;
    } catch (e) {
      if (!isUniqueConstraintViolation(e)) throw e;
      const winner = await this.store.get(order.id);
      const resolved = resolveCreateCantonSwapOrder(winner, incoming, now);
      if (!resolved.isNew && isCantonSwapActive(resolved.order)) {
        return resolved.order;
      }
      throw new Error("order id already exists with different or inactive terms");
    }
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

  private async currentSwapFloatUnits(
    vault: string,
    toAsset: CantonSwapMvpAssetId
  ): Promise<bigint> {
    const counterHoldings = await holdingsForSwapAsset(vault, toAsset);
    const counterAsset = getSwapAsset(toAsset);
    let float = 0n;
    for (const h of counterHoldings) {
      const amt = h.payload?.amount ?? "0";
      float += toBaseUnitsFloor(String(amt), counterAsset.decimals);
    }
    return float;
  }

  private async assertCurrentSwapFloat(
    o: CantonSwapOrder
  ): Promise<void> {
    const asset = getSwapAsset(o.toAsset);
    const need = toBaseUnits(o.outAmount, asset.decimals);
    const current = await this.currentSwapFloatUnits(swapParty(o), o.toAsset);
    if (current < need) {
      throw new Error(
        `swap vault insufficient ${o.toAsset} float (need ${o.outAmount}, ` +
          `${fromBaseUnits(current, asset.decimals)} currently spendable)`
      );
    }
  }

  private async reserveSwapFloat(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus,
    nextStatus: CantonSwapStatus,
    evidence?: { userLegOfferCid?: string; userLegSubmitUpdateId?: string }
  ): Promise<CantonSwapOrder> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const floatUnits = await this.currentSwapFloatUnits(swapParty(o), o.toAsset);
      try {
        await this.store.reserveFloat({
          orderId: o.id,
          expectedStatus,
          nextStatus,
          floatUnits,
          ...evidence
        });
        const reserved = await this.must(o.id);
        if (reserved.status !== nextStatus || !reserved.floatReserved) {
          throw new Error("swap float reservation committed without expected order state");
        }
        return reserved;
      } catch (e) {
        if (
          attempt < 2 &&
          e instanceof Error &&
          e.message.includes("insufficient float")
        ) {
          continue;
        }
        throw e;
      }
    }
    throw new Error("swap float reservation failed after retries");
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
    const o = await this.store.get(id);
    if (!o) return undefined;
    if (o.status !== "expired") return o;
    try {
      return await this.reopenFalseVaultMigrationIfNeeded(id);
    } catch {
      return o;
    }
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
      if (!o.floatReserved && !o.settlementUpdateId) {
        o = await this.reserveSwapFloat(o, "settling", "settling");
      }
      return this.completeSettling(o);
    }
    if (o.status !== "open") {
      throw new Error(`cannot settle from status ${o.status}`);
    }

    await this.enforceSettlementQuote(o);
    try {
      o = await this.reserveSwapFloat(o, "open", "settling");
    } catch (e) {
      o = await this.must(id);
      if (o.status === "filled") return o;
      if (o.status === "settling") return this.completeSettling(o);
      throw e;
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
        if (!(await this.store.putIfStatus(o, "settling"))) {
          o = await this.must(o.id);
        }
      }
      if (!o.userLegOfferCid) {
        const created = await ensureManagedUserLegOffer(o);
        o.userLegOfferCid = created.userLegOfferCid;
        if (!(await this.transition(o, "settling"))) {
          o = await this.must(o.id);
          if (!o.userLegOfferCid) {
            throw new Error("managed user offer created but could not be persisted");
          }
        }
      }
      const result = await settleManagedSwap(o);
      if (result.networkFeeCollected) {
        o.networkFeeSettlementUpdateId = result.updateId;
        o.networkFeeAccountingPending = true;
      }
      this.applyManagedFillResult(o, result);
      if (!(await this.transition(o, "settling"))) {
        const fresh = await this.must(o.id);
        if (fresh.status === "filled") return fresh;
        return fresh;
      }
      if (result.networkFeeCollected && feeEstimate) {
        try {
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
          const fresh = await this.must(o.id);
          if (fresh.networkFeeAccountingPending) {
            fresh.networkFeeAccountingPending = false;
            await this.store.putIfStatus(fresh, fresh.status);
          }
        } catch (accountingError) {
          console.warn(
            `[canton-swap] fee accounting deferred ${o.id.slice(0, 12)}:`,
            accountingError instanceof Error
              ? accountingError.message
              : accountingError
          );
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
        await this.store.putIfStatus(o, "settling");
        throw e;
      }
      if (o.userLegOfferCid && !o.settlementUpdateId) {
        try {
          await rejectUserLegOffer(o);
        } catch (rejectError) {
          o.status = "settling";
          o.failureReason =
            `Settle failed and user sell offer rejection failed: ${
              rejectError instanceof Error
                ? rejectError.message
                : String(rejectError)
            }`;
          await this.store.putIfStatus(o, "settling");
          throw e;
        }
      }
      o.status = "failed";
      o.floatReserved = false;
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
      return this.must(o.id);
    }
    // P2a: do NOT record fee collection on the repair path. repairManagedFillFromLedger
    // verifies only the SWAP legs of the recovered tx — it does NOT prove a fee leg was
    // present. The env flag + order.networkFeeCc are configuration/metadata, not on-ledger
    // evidence (fees could have been toggled on after the fill, or the fee leg could have
    // been absent while the swap legs settled). Recording from that would book revenue
    // that may not have been collected. Instead, surface it for manual/aggregate
    // reconciliation; only the authoritative settle path (which sees result.networkFeeCollected)
    // records the fee.
    if (
      isNetworkFeeEnabled() &&
      o.networkFeeCc &&
      Number.parseFloat(o.networkFeeCc) > 0
    ) {
      console.warn(
        `[canton-swap] repaired fill ${o.id.slice(0, 12)} has a bound fee (${o.networkFeeCc} CC) but the fee leg was not verified on-ledger — NOT recording; reconcile manually.`
      );
    }
    return o;
  }

  /** Re-open loop orders falsely expired by vault-migration daemon (stale env / createdAt race). */
  async reopenFalseVaultMigrationIfNeeded(id: string): Promise<CantonSwapOrder> {
    const vaultParty = expectedCantonSwapParty();
    let o = await this.must(id);
    const afterUserLeg = isFalseVaultMigrationExpire(o, vaultParty, {
      afterUserLeg: true
    });
    const beforeUserLeg = isFalseVaultMigrationExpire(o, vaultParty);
    if (!afterUserLeg && !beforeUserLeg) return o;

    const targetStatus = afterUserLeg ? "user_locked" : "open";
    o.status = targetStatus;
    o.failureReason = undefined;
    if (!(await this.transition(o, "expired"))) {
      o = await this.must(id);
      if (o.status !== targetStatus) {
        throw new Error(`cannot reopen order from status ${o.status}`);
      }
    }
    return o;
  }

  async prepareUserLeg(
    id: string,
    opts?: { inputHoldingCids?: string[] }
  ): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
    transferKind: string;
    counterRequiresAccept: boolean;
  }> {
    const o = await this.reopenFalseVaultMigrationIfNeeded(id);
    if (o.walletMode !== "loop") throw new Error("prepare-user-leg is loop only");
    if (o.status !== "open") throw new Error(`invalid status ${o.status}`);
    assertOrderNotExpired(o);
    const cids = opts?.inputHoldingCids?.filter(Boolean) ?? [];
    if (cids.length > 0) {
      return prepareLoopUserLegWithCids(o, cids);
    }
    return prepareLoopUserLeg(o);
  }

  async confirmUserLeg(
    id: string,
    params?: { offerCid?: string; submitUpdateId?: string }
  ): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("confirm-user-leg is loop only");
    if (o.status === "user_locked") return o;

    const vaultParty = expectedCantonSwapParty();
    const falseVaultMigrationExpire = isFalseVaultMigrationExpire(o, vaultParty);

    if (o.status !== "open" && !falseVaultMigrationExpire) {
      throw new Error(`invalid status ${o.status}`);
    }
    if (!falseVaultMigrationExpire) {
      assertOrderNotExpired(o);
    }

    const fromStatus = falseVaultMigrationExpire ? "expired" : "open";
    const reservedCids = await this.reservedUserLegCids(id);
    const resolved = await resolveUserLegEvidence(o, {
      maxAttempts: 10,
      pollMs: 1500,
      reservedCids,
      offerCidHint: params?.offerCid,
      submitUpdateId: params?.submitUpdateId
    });
    try {
      return await this.reserveSwapFloat(o, fromStatus, "user_locked", {
        userLegOfferCid: resolved.userLegOfferCid,
        userLegSubmitUpdateId:
          resolved.userLegSubmitUpdateId ?? params?.submitUpdateId
      });
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        throw new Error("user leg offer already reserved by another order");
      }
      const fresh = await this.must(id);
      if (fresh.status === "user_locked") return fresh;
      try {
        await rejectUserLegOffer({
          ...o,
          userLegOfferCid: resolved.userLegOfferCid,
          userLegSubmitUpdateId:
            resolved.userLegSubmitUpdateId ?? params?.submitUpdateId
        });
      } catch (rejectError) {
        console.warn(
          `[canton-swap] failed to reject unreserved user offer ${resolved.userLegOfferCid.slice(0, 16)}…:`,
          rejectError instanceof Error ? rejectError.message : rejectError
        );
      }
      throw e;
    }
  }

  private async reservedUserLegCids(excludeOrderId: string): Promise<Set<string>> {
    const used = await this.store.usedUserLegOfferCids();
    const self = await this.store.get(excludeOrderId);
    if (self?.userLegOfferCid) used.delete(self.userLegOfferCid);
    return used;
  }

  async prepareUserLegIntent(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    inputHoldingCids: string[];
    orderId?: string;
  }): Promise<{
    orderId: string;
    createdAt: number;
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
    transferKind: string;
    counterRequiresAccept: boolean;
    expectedMemo: string;
  }> {
    const vaultParty = expectedCantonSwapParty();
    if (!vaultParty) {
      throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not configured");
    }
    assertSwapPayAmountLimit(params.fromAsset, params.inAmount);
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
    if (toBaseUnits(params.outAmount, to.decimals) > q.outUnits) {
      throw new Error(`outAmount ${params.outAmount} exceeds quote`);
    }
    const orderId = params.orderId ?? randomUUID();
    const createdAt = issuePrepareCreatedAt();
    const draft: CantonSwapOrder = {
      id: orderId,
      status: "open",
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      minOut: settlementMinOutAmount(params.outAmount, to.decimals),
      quoteExpiresAt: q.expiresAt,
      userParty: params.userParty,
      solverParty: vaultParty,
      settlementParty: vaultParty,
      walletMode: "loop",
      createdAt
    };
    const prep = await prepareLoopUserLegWithCids(draft, params.inputHoldingCids);
    const { cantonSwapUserLegMemoFromTerms } = await import("./swap-transfer-memo");
    return {
      orderId,
      createdAt,
      expectedMemo: cantonSwapUserLegMemoFromTerms(draft),
      ...prep
    };
  }

  async commitUserLegOrder(params: {
    fromAsset: CantonSwapMvpAssetId;
    toAsset: CantonSwapMvpAssetId;
    inAmount: string;
    outAmount: string;
    userParty: string;
    orderId: string;
    createdAt: number;
    submitUpdateId: string;
    offerCidHint?: string;
  }): Promise<CantonSwapOrder> {
    const vaultParty = expectedCantonSwapParty();
    if (!vaultParty) {
      throw new Error("CANTON_SWAP_SETTLEMENT_PARTY not configured");
    }
    const createdAt = assertValidPrepareCreatedAt(params.createdAt);
    const { resolveSwapInstrumentId } = await import("./canton-swap-holdings");
    const expectedInstrument = await resolveSwapInstrumentId(params.fromAsset);
    const { cantonSwapUserLegMemoFromTerms } = await import("./swap-transfer-memo");
    const expectedMemo = cantonSwapUserLegMemoFromTerms({
      id: params.orderId,
      createdAt,
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      userParty: params.userParty,
      solverParty: vaultParty,
      settlementParty: vaultParty
    });
    const { verifyUserLegFromSubmitUpdate } = await import("./canton-swap-leg-verify");
    const { assertOfferOnlyUserLegEvidence } = await import(
      "./canton-swap-leg-verify-logic"
    );
    const evidence = await verifyUserLegFromSubmitUpdate(params.submitUpdateId, {
      userParty: params.userParty,
      solverParty: vaultParty,
      inAmount: params.inAmount,
      fromAsset: params.fromAsset,
      expectedInstrument,
      expectedMemo,
      strictOrderBoundMemo: true
    });
    assertOfferOnlyUserLegEvidence(evidence);
    const used = await this.store.usedUserLegOfferCids();
    if (evidence.offerCid && used.has(evidence.offerCid)) {
      throw new Error("user leg offer already reserved by another order");
    }
    await this.createOrder({
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      userParty: params.userParty,
      walletMode: "loop",
      orderId: params.orderId,
      createdAt
    });
    return this.confirmUserLeg(params.orderId, {
      offerCid: evidence.offerCid,
      submitUpdateId: params.submitUpdateId
    });
  }

  async fillLoop(id: string): Promise<CantonSwapOrder> {
    let o = await this.reopenFalseVaultMigrationIfNeeded(id);
    if (o.walletMode !== "loop") throw new Error("fill is loop only");
    if (o.status === "filled") return o;
    if (o.status === "filling") {
      o = await this.must(id);
      if (o.status === "filled") return o;
      if (isLoopFillPendingCounterAccept(o)) return o;
    }

    if (o.status === "expired") {
      throw new Error(`cannot fill from status ${o.status}`);
    }

    const vaultParty = expectedCantonSwapParty();
    const falseVaultMigrationExpire = isFalseVaultMigrationExpire(o, vaultParty, {
      afterUserLeg: true
    });

    if (falseVaultMigrationExpire) {
      o.status = "user_locked";
      o.failureReason = undefined;
      if (!(await this.transition(o, "expired"))) {
        o = await this.must(id);
        if (o.status === "filled") return o;
        if (isLoopFillPendingCounterAccept(o)) return o;
        if (o.status !== "user_locked" && o.status !== "filling") {
          throw new Error(`cannot fill from status ${o.status}`);
        }
      }
    }

    if (o.status !== "user_locked" && o.status !== "filling") {
      throw new Error(`cannot fill from status ${o.status}`);
    }
    if (isLoopFillPendingCounterAccept(o)) {
      return o;
    }
    await this.enforceSettlementQuote(o);
    if (!o.floatReserved && !o.settlementUpdateId) {
      o = await this.reserveSwapFloat(o, o.status, o.status);
    }
    await this.assertCurrentSwapFloat(o);

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
        o.failureReason = formatSettlementError(msg);
        await this.transition(o, "filling");
        return this.must(id);
      }
      if (
        o.walletMode === "loop" &&
        o.userLegOfferCid &&
        !o.settlementUpdateId
      ) {
        try {
          await rejectUserLegOffer(o);
        } catch (rejectErr) {
          console.warn(
            `[canton-swap] reject on fill failed ${o.id.slice(0, 12)}:`,
            rejectErr instanceof Error ? rejectErr.message : rejectErr
          );
        }
      }
      o.status = "failed";
      o.floatReserved = false;
      o.failureReason = formatSettlementError(msg);
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
      counterLegCreatedOffset?: number;
    }
  ): void {
    if (!result.updateId) {
      throw new Error("fill result missing settlement update id");
    }
    o.settlementUpdateId = result.updateId;
    o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
    o.counterLegCreatedOffset = result.counterLegPendingAccept
      ? result.counterLegCreatedOffset
      : undefined;
    o.counterReceiptUpdateId = undefined;
    o.counterPendingClearedAt = undefined;
    o.floatReserved = result.counterLegPendingAccept;
    o.status = result.counterLegPendingAccept ? "user_locked" : "filled";
    if (result.counterLegPendingAccept) {
      o.failureReason =
        "Counter leg pending Loop accept — user must accept incoming transfer";
    } else {
      o.counterReceiptUpdateId = result.updateId;
      o.failureReason = undefined;
    }
  }

  private applyManagedFillResult(
    o: CantonSwapOrder,
    result: {
      updateId: string;
      counterLegOfferCid?: string;
      counterLegPendingAccept: boolean;
      counterLegCreatedOffset?: number;
    }
  ): void {
    if (!result.updateId) {
      throw new Error("settle result missing settlement update id");
    }
    o.settlementUpdateId = result.updateId;
    o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
    o.counterLegCreatedOffset = result.counterLegPendingAccept
      ? result.counterLegCreatedOffset
      : undefined;
    o.counterReceiptUpdateId = undefined;
    o.floatReserved = false;
    if (result.counterLegPendingAccept) {
      o.status = "settling";
      o.failureReason =
        "Counter leg pending accept — accept incoming transfer to complete swap";
    } else {
      o.status = "filled";
      o.counterReceiptUpdateId = result.updateId;
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
            o.counterLegOfferCid
          ) {
            const proof = await verifyCounterLegReceiptProof(o);
            if (proof.status === "received") {
              o.counterReceiptUpdateId =
                proof.updateId ?? o.counterReceiptUpdateId;
              o.status = "filled";
              o.failureReason = undefined;
              if (await this.transition(o, "settling")) {
                n++;
              }
            }
          }
        } catch {
          // leave for next tick
        }
      }
    }
    return n;
  }

  private applyFilledProofRepair(
    o: CantonSwapOrder,
    result: {
      updateId: string;
      counterLegOfferCid?: string;
      counterLegPendingAccept: boolean;
      counterLegCreatedOffset?: number;
    }
  ): void {
    o.settlementUpdateId = result.updateId;
    o.floatReserved = false;
    o.counterPendingClearedAt = undefined;
    if (result.counterLegPendingAccept) {
      o.counterLegOfferCid = result.counterLegOfferCid;
      o.counterLegCreatedOffset = result.counterLegCreatedOffset;
      o.counterReceiptUpdateId = undefined;
      o.status = "user_locked";
      o.failureReason =
        "Counter leg pending Loop accept — user must accept incoming transfer";
      return;
    }
    o.counterReceiptUpdateId = result.updateId;
    o.counterLegOfferCid = result.counterLegOfferCid;
    o.counterLegCreatedOffset = undefined;
    o.status = "filled";
    o.failureReason = undefined;
  }

  private async tryCompleteFromSettlementDelivery(
    o: CantonSwapOrder,
    expectedStatus: CantonSwapStatus
  ): Promise<"filled" | "blocked" | "continue"> {
    const delivery = await proveCounterDeliveredOnSettlement(o);
    if (delivery === "unreadable") {
      o.failureReason =
        "Counter receipt proof incomplete — settlement ledger unreadable; reissue blocked";
      await this.store.putIfStatus(o, expectedStatus);
      return "blocked";
    }
    if (!delivery) return "continue";

    o.counterReceiptUpdateId = delivery.updateId;
    o.counterLegOfferCid = undefined;
    o.counterLegCreatedOffset = undefined;
    o.counterPendingClearedAt = undefined;
    o.status = "filled";
    o.failureReason = undefined;
    if (await this.transition(o, expectedStatus)) {
      return "filled";
    }
    return "continue";
  }

  /** Re-issue expired counter offers after the user sell leg was already taken. */
  async reconcileLoopCounters(): Promise<number> {
    const orders = await this.store.byStatus("user_locked");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "loop") continue;
      if (!o.settlementUpdateId || !o.counterLegOfferCid) continue;

      try {
      const pending = await listPendingOffersStrict(o.userParty);
      if (pending.some((p) => p.contractId === o.counterLegOfferCid)) {
        if (o.counterPendingClearedAt !== undefined) {
          o.counterPendingClearedAt = undefined;
          await this.store.putIfStatus(o, "user_locked");
        }
        continue;
      }

      const receiptProof = await verifyCounterLegReceiptProof(o, {
        maxAttempts: 8,
        pollMs: 1500
      });
      if (receiptProof.status === "received") {
        o.counterReceiptUpdateId =
          receiptProof.updateId ?? o.counterReceiptUpdateId;
        o.status = "filled";
        o.failureReason = undefined;
        o.counterPendingClearedAt = undefined;
        if (await this.transition(o, "user_locked")) {
          n++;
        }
        continue;
      }
      if (receiptProof.status === "pending") {
        if (o.counterPendingClearedAt !== undefined) {
          o.counterPendingClearedAt = undefined;
          await this.store.putIfStatus(o, "user_locked");
        }
        continue;
      }
      if (receiptProof.status === "unknown") {
        o.failureReason =
          "Counter receipt proof incomplete — reissue blocked until creation offset is recovered";
        await this.store.putIfStatus(o, "user_locked");
        continue;
      }

      const earlyDelivery = await this.tryCompleteFromSettlementDelivery(
        o,
        "user_locked"
      );
      if (earlyDelivery === "filled" || earlyDelivery === "blocked") {
        if (earlyDelivery === "filled") n++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      if (!o.counterPendingClearedAt) {
        o.counterPendingClearedAt = now;
        o.failureReason =
          "Verifying counter accept on ledger — wait before reissue";
        await this.store.putIfStatus(o, "user_locked");
        continue;
      }
      if (!counterReissueCooldownElapsed(o.counterPendingClearedAt, now)) {
        continue;
      }

      const priorOfferCid = o.counterLegOfferCid;
      const priorAttempt = o.counterReissueAttempt ?? 0;
      let fresh = await this.must(o.id);
      if (
        fresh.counterLegOfferCid !== priorOfferCid ||
        (fresh.counterReissueAttempt ?? 0) !== priorAttempt
      ) {
        continue;
      }

      const recheck = await verifyCounterLegReceiptProof(fresh, {
        maxAttempts: 4,
        pollMs: 1000
      });
      if (recheck.status === "received") {
        fresh.counterReceiptUpdateId =
          recheck.updateId ?? fresh.counterReceiptUpdateId;
        fresh.status = "filled";
        fresh.failureReason = undefined;
        fresh.counterPendingClearedAt = undefined;
        if (await this.transition(fresh, "user_locked")) {
          n++;
        }
        continue;
      }
      if (recheck.status === "pending") {
        fresh.counterPendingClearedAt = undefined;
        await this.store.putIfStatus(fresh, "user_locked");
        continue;
      }
      if (recheck.status === "unknown") {
        fresh.failureReason =
          "Counter receipt proof incomplete — refusing unsafe reissue";
        await this.store.putIfStatus(fresh, "user_locked");
        continue;
      }

      const deliveryBeforeReissue = await this.tryCompleteFromSettlementDelivery(
        fresh,
        "user_locked"
      );
      if (deliveryBeforeReissue === "filled" || deliveryBeforeReissue === "blocked") {
        if (deliveryBeforeReissue === "filled") n++;
        continue;
      }

      console.warn(
        `[canton-swap] COUNTER REISSUE order=${fresh.id.slice(0, 12)}… ` +
          `priorCid=${priorOfferCid.slice(0, 16)}… attempt=${priorAttempt + 1} ` +
          `settlement=${fresh.settlementUpdateId?.slice(0, 16)}…`
      );

      try {
        if (!fresh.floatReserved) {
          fresh = await this.reserveSwapFloat(
            fresh,
            "user_locked",
            "user_locked"
          );
          if (
            fresh.counterLegOfferCid !== priorOfferCid ||
            (fresh.counterReissueAttempt ?? 0) !== priorAttempt
          ) {
            continue;
          }
        }
        await this.assertCurrentSwapFloat(fresh);

        const result = await reissueLoopCounterLeg(fresh);
        fresh.counterReissueAttempt = result.counterReissueAttempt;
        fresh.counterLegOfferCid = result.counterLegOfferCid ?? fresh.counterLegOfferCid;
        fresh.counterLegCreatedOffset = result.counterLegPendingAccept
          ? result.counterLegCreatedOffset
          : undefined;
        fresh.counterReceiptUpdateId = undefined;
        fresh.counterPendingClearedAt = undefined;
        if (result.counterLegPendingAccept) {
          fresh.failureReason =
            "Counter leg pending Loop accept — user must accept incoming transfer";
        } else {
          fresh.status = "filled";
          fresh.failureReason = undefined;
          fresh.counterReceiptUpdateId = result.updateId;
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
      } catch (e) {
        console.warn(
          `[canton-swap] reconcileLoopCounters failed ${o.id.slice(0, 12)}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
    return n;
  }

  /** Repair filled Loop orders missing counter delivery or accept proof (repair-only; no reissue). */
  async reconcileFilledLoopCounterProof(): Promise<number> {
    const orders = await this.store.byStatus("filled");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "loop") continue;
      if (c2cCounterLegProofPresent(o)) continue;
      if (!o.settlementUpdateId) continue;

      try {
        const repaired =
          (await repairLoopFillFromSettlement(o)) ??
          (await repairLoopFillFromLedger(o));
        if (repaired) {
          this.applyFilledProofRepair(o, repaired);
          if (await this.transition(o, "filled")) {
            n++;
          }
          continue;
        }

        const delivery = await proveCounterDeliveredOnSettlement(o);
        if (delivery === "unreadable") {
          o.failureReason =
            "Counter receipt proof missing — refusing repair until settlement ledger is readable";
          await this.store.putIfStatus(o, "filled");
          continue;
        }
        if (delivery) {
          o.counterReceiptUpdateId = delivery.updateId;
          o.failureReason = undefined;
          if (await this.transition(o, "filled")) {
            n++;
          }
          continue;
        }

        o.failureReason =
          "Counter receipt proof missing on filled order — reissue disabled; use user_locked reconcile path";
        await this.store.putIfStatus(o, "filled");
      } catch (e) {
        console.warn(
          `[canton-swap] filled counter proof repair failed ${o.id.slice(0, 12)}:`,
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
    for (const status of ["open", "user_locked", "settling", "filling", "failed"] as const) {
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
            // Keep the order active so the next sweep retries. Marking it terminal
            // here would strand the user's still-pending sell offer.
            continue;
          }
          const priorStatus = o.status;
          o.status = "expired";
          o.floatReserved = false;
          o.failureReason = "order superseded — settlement vault migration";
          if (await this.transition(o, priorStatus)) {
            n++;
          }
          continue;
        }
        if (isLoopFillPendingCounterAccept(o)) continue;
        if (isLoopFillInFlight(o)) continue;
        if (o.status === "failed") {
          if (o.userLegOfferCid && !o.settlementUpdateId) {
            try {
              await rejectUserLegOffer(o);
            } catch (e) {
              console.warn(
                `[canton-swap] reject on failed expire ${o.id.slice(0, 12)}:`,
                e instanceof Error ? e.message : e
              );
              continue;
            }
          }
          if (!isOrderExpired(o, now)) continue;
        }
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
            (priorStatus === "user_locked" ||
              priorStatus === "filling" ||
              priorStatus === "settling") &&
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
          continue;
        }

        o.status = "expired";
        o.floatReserved = false;
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
    o.floatReserved = false;
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

  async history(
    party: string,
    query?: import("@/lib/htlc-order-logic").PartyHistoryQuery
  ): Promise<{ orders: CantonSwapOrder[]; hasMore: boolean }> {
    const { orders, hasMore } = await this.store.byPartyPage(party, query);
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
    return { orders: out, hasMore };
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

    const receiptProof = await verifyCounterLegReceiptProof(o, {
      maxAttempts: 5,
      pollMs: 1500
    });
    if (receiptProof.status !== "received") {
      throw new Error(
        "Counter leg accept not verified — complete Loop accept or wait for settlement"
      );
    }
    o.counterReceiptUpdateId =
      receiptProof.updateId ?? o.counterReceiptUpdateId;

    // Record before the terminal transition. This write is deliberately strict:
    // if accounting storage is unavailable, leave the order re-entrant so the next
    // markCounterAccepted retry performs the idempotent write before setting filled.
    if (
      o.walletMode === "managed" &&
      isNetworkFeeEnabled() &&
      o.networkFeeCc &&
      Number.parseFloat(o.networkFeeCc) > 0 &&
      o.settlementUpdateId
    ) {
      await recordNetworkFeeCollected({
        orderId: o.id,
        orderKind: "c2c",
        userParty: o.userParty,
        feeCc: o.networkFeeCc,
        networkFeeSource: "settle",
        receiverParty: networkFeeReceiverParty(),
        settlementUpdateId: o.settlementUpdateId
      });
      o.networkFeeAccountingPending = false;
      o.networkFeeSettlementUpdateId = o.settlementUpdateId;
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

  /** Durable fee-accounting outbox reconciliation. */
  async reconcileNetworkFeeAccounting(): Promise<number> {
    const pending = await this.store.pendingNetworkFeeAccounting();
    let count = 0;
    for (const o of pending) {
      if (
        !o.networkFeeCc ||
        !o.networkFeeSettlementUpdateId ||
        Number.parseFloat(o.networkFeeCc) <= 0
      ) {
        continue;
      }
      try {
        await recordNetworkFeeCollected({
          orderId: o.id,
          orderKind: "c2c",
          userParty: o.userParty,
          feeCc: o.networkFeeCc,
          networkFeeSource: "reconciled",
          receiverParty: networkFeeReceiverParty(),
          settlementUpdateId: o.networkFeeSettlementUpdateId
        });
        o.networkFeeAccountingPending = false;
        if (await this.store.putIfStatus(o, o.status)) count++;
      } catch {
        // Keep pending for the next daemon pass.
      }
    }
    return count;
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
