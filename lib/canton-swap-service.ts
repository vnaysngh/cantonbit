import "server-only";

import { fromBaseUnits, toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { getSwapAsset } from "./canton-assets";
import {
  assertOrderNotExpired,
  isLoopFillPendingCounterAccept,
  isOrderExpired,
  LOOP_USER_LEG_OFFER_TTL_SECONDS,
  resolveCreateCantonSwapOrder
} from "./canton-swap-order-logic";
import { assertSettlementQuoteFresh, assertMvpOrderAmounts, quoteMvpCantonSwap } from "./canton-swap-quote";
import {
  holdingsForSwapAsset
} from "./canton-swap-holdings";
import {
  fillLoopSwap,
  prepareLoopUserLeg,
  rejectUserLegOffer,
  reissueLoopCounterLeg,
  resolveUserLegOfferCid,
  settleManagedSwap,
  safeListPendingOffers,
  verifyUserLegOffer
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
import { expectedSolverCanton } from "./htlc-auth";
import { listPendingOffers } from "./transfer";
import { NETWORK } from "./constants";
import { randomUUID } from "crypto";

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
    const solverParty = expectedSolverCanton();
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

    const incoming = {
      id: params.orderId ?? randomUUID(),
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      inAmount: params.inAmount,
      outAmount: params.outAmount,
      minOut: params.outAmount,
      quoteExpiresAt: q.expiresAt,
      userParty: params.userParty,
      solverParty,
      walletMode: params.walletMode
    };
    const existing = await this.store.get(incoming.id);
    const { order, isNew } = resolveCreateCantonSwapOrder(
      existing,
      incoming,
      Math.floor(Date.now() / 1000)
    );
    if (isNew) await this.store.put(order);
    return order;
  }

  private async assertSolverFloat(
    solverParty: string,
    toAsset: CantonSwapMvpAssetId,
    outAmount: string
  ): Promise<void> {
    const counterHoldings = await holdingsForSwapAsset(solverParty, toAsset);
    const counterAsset = getSwapAsset(toAsset);
    const need = toBaseUnits(outAmount, counterAsset.decimals);
    let float = 0n;
    for (const h of counterHoldings) {
      const amt = h.payload?.amount ?? "0";
      float += toBaseUnitsFloor(String(amt), counterAsset.decimals);
    }

    const reservedStr = await this.store.sumReservedOut(solverParty, toAsset);
    const reserved = toBaseUnitsFloor(reservedStr, counterAsset.decimals);
    const available = float > reserved ? float - reserved : 0n;

    if (available < need) {
      throw new Error(
        `solver insufficient ${toAsset} float (need ${outAmount}, ${fromBaseUnits(available, counterAsset.decimals)} available after reservations)`
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
    await this.assertSolverFloat(o.solverParty, o.toAsset, o.outAmount);
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
    try {
      await this.enforceSettlementQuote(o);
      const { updateId } = await settleManagedSwap(o);
      o.settlementUpdateId = updateId || o.settlementUpdateId;
      o.status = "filled";
      o.failureReason = undefined;
      if (!(await this.transition(o, "settling"))) {
        const fresh = await this.must(o.id);
        if (fresh.status === "filled") return fresh;
      }
      return o;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate command") && o.settlementUpdateId) {
        o.status = "filled";
        o.failureReason = undefined;
        await this.transition(o, "settling");
        return o;
      }
      o.status = "failed";
      o.failureReason = msg;
      await this.transition(o, "settling");
      throw e;
    }
  }

  async prepareUserLeg(id: string): Promise<{
    command: unknown;
    disclosedContracts: unknown[];
    synchronizerId: string;
  }> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("prepare-user-leg is loop only");
    if (o.status !== "open") throw new Error(`invalid status ${o.status}`);
    assertOrderNotExpired(o);
    return prepareLoopUserLeg(o);
  }

  async confirmUserLeg(id: string, offerCid?: string): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") throw new Error("confirm-user-leg is loop only");
    if (o.status === "user_locked") return o;
    if (o.status !== "open") throw new Error(`invalid status ${o.status}`);
    assertOrderNotExpired(o);
    const reservedCids = await this.reservedUserLegOfferCids(id);
    let trimmed = offerCid?.trim() ?? "";
    if (trimmed) {
      try {
        await verifyUserLegOffer(o, trimmed, { maxAttempts: 3, pollMs: 800 });
      } catch {
        trimmed = "";
      }
    }
    if (!trimmed) {
      trimmed = await resolveUserLegOfferCid(o, {
        maxAttempts: 10,
        pollMs: 1500,
        reservedCids
      });
    }
    await this.assertSolverFloat(o.solverParty, o.toAsset, o.outAmount);
    o.userLegOfferCid = trimmed;
    o.status = "user_locked";
    if (!(await this.transition(o, "open"))) {
      const fresh = await this.must(id);
      if (fresh.status === "user_locked") {
        return fresh;
      }
      throw new Error(`cannot confirm user leg from status ${fresh.status}`);
    }
    return o;
  }

  private async reservedUserLegOfferCids(excludeOrderId: string): Promise<Set<string>> {
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

    try {
      const result = await fillLoopSwap(o);
      o.settlementUpdateId = result.updateId || o.settlementUpdateId;
      o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
      o.status = result.counterLegPendingAccept ? "user_locked" : "filled";
      if (result.counterLegPendingAccept) {
        o.failureReason =
          "Counter leg pending Loop accept — user must accept incoming transfer";
      } else {
        o.failureReason = undefined;
      }
      if (!(await this.transition(o, "filling"))) {
        return this.must(id);
      }
      return o;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate command")) {
        o = await this.must(id);
        if (o.settlementUpdateId) {
          o.status = isLoopFillPendingCounterAccept(o) ? "user_locked" : "filled";
          if (!isLoopFillPendingCounterAccept(o)) {
            o.failureReason = undefined;
          }
          await this.transition(o, "filling");
          return o;
        }
        o.status = "user_locked";
        o.failureReason = undefined;
        await this.transition(o, "filling");
        return this.must(id);
      }
      o.status = "failed";
      o.failureReason = msg;
      await this.transition(o, "filling");
      throw e;
    }
  }

  /** Retry orders stuck in settling after a crash between ledger submit and DB update. */
  async reconcileSettling(): Promise<number> {
    const orders = await this.store.byStatus("settling");
    let n = 0;
    for (const o of orders) {
      if (o.walletMode !== "managed") continue;
      try {
        await this.completeSettling(o);
        n++;
      } catch {
        // leave failed state on order
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

      const pending = await listPendingOffers(o.userParty);
      if (pending.some((p) => p.contractId === o.counterLegOfferCid)) {
        continue;
      }

      try {
        const result = await reissueLoopCounterLeg(o);
        o.counterLegOfferCid = result.counterLegOfferCid ?? o.counterLegOfferCid;
        if (result.counterLegPendingAccept) {
          o.failureReason =
            "Counter leg pending Loop accept — user must accept incoming transfer";
        } else {
          o.status = "filled";
          o.failureReason = undefined;
        }
        if (await this.transition(o, "user_locked")) {
          n++;
        }
      } catch (e) {
        console.warn(
          `[canton-swap] counter reissue failed ${o.id.slice(0, 12)}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
    return n;
  }

  async expireStale(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    for (const status of ["open", "user_locked"] as const) {
      const orders = await this.store.byStatus(status);
      for (const o of orders) {
        if (isLoopFillPendingCounterAccept(o)) continue;
        if (!isOrderExpired(o, now)) continue;

        const priorStatus = o.status;
        try {
          if (
            priorStatus === "user_locked" &&
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

  async history(party: string, limit = 50): Promise<CantonSwapOrder[]> {
    return this.store.byParty(party, limit);
  }

  async markCounterAccepted(id: string): Promise<CantonSwapOrder> {
    const o = await this.must(id);
    if (o.walletMode !== "loop") {
      throw new Error("counter accept is loop only");
    }
    if (o.status !== "user_locked") {
      throw new Error(`invalid status ${o.status}`);
    }
    if (!o.counterLegOfferCid) {
      throw new Error("no counter leg offer on order");
    }
    if (!o.settlementUpdateId) {
      throw new Error("solver fill not completed yet");
    }

    const pending = await safeListPendingOffers(o.userParty);
    if (pending.some((p) => p.contractId === o.counterLegOfferCid)) {
      throw new Error(
        "Counter leg not accepted yet — complete the Loop accept first"
      );
    }

    o.status = "filled";
    o.failureReason = undefined;
    if (!(await this.transition(o, "user_locked"))) {
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
