import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isLoopFillPendingCounterAccept,
  isOrderExpired,
  isRetriableLoopFillError,
  counterReissueCooldownElapsed,
  loopCounterReissueCommandId,
  loopFillCommandId,
  loopOrderDeadline,
  LOOP_SWAP_ORDER_TTL_SECONDS,
  resolveCreateCantonSwapOrder,
  shouldSkipLoopFill
} from "./canton-swap-order-logic";
import type { CantonSwapOrder } from "./canton-swap-types";

function baseOrder(over: Partial<CantonSwapOrder> = {}): CantonSwapOrder {
  return {
    id: "test-id",
    status: "open",
    fromAsset: "CC",
    toAsset: "CBTC",
    inAmount: "1",
    outAmount: "0.001",
    minOut: "0.001",
    quoteExpiresAt: 1_000,
    userParty: "user::1",
    solverParty: "solver::1",
    walletMode: "loop",
    createdAt: 1_000,
    ...over
  };
}

test("loop order uses extended TTL from createdAt", () => {
  const o = baseOrder({ createdAt: 10_000 });
  assert.equal(loopOrderDeadline(o), 10_000 + LOOP_SWAP_ORDER_TTL_SECONDS);
});

test("loop user_locked with counter pending never auto-expires", () => {
  const o = baseOrder({
    status: "user_locked",
    settlementUpdateId: "upd-1",
    counterLegOfferCid: "offer-1",
    createdAt: 0,
    quoteExpiresAt: 1
  });
  assert.equal(isOrderExpired(o, 999_999), false);
});

test("shouldSkipLoopFill when counter accept pending", () => {
  const o = baseOrder({
    status: "user_locked",
    settlementUpdateId: "upd-1",
    counterLegOfferCid: "offer-1"
  });
  assert.equal(shouldSkipLoopFill(o), true);
  assert.equal(isLoopFillPendingCounterAccept(o), true);
});

test("open loop order expires after loop TTL", () => {
  const o = baseOrder({ status: "open", createdAt: 100 });
  assert.equal(isOrderExpired(o, 100 + LOOP_SWAP_ORDER_TTL_SECONDS), false);
  assert.equal(isOrderExpired(o, 100 + LOOP_SWAP_ORDER_TTL_SECONDS + 1), true);
});

test("managed settling with counter pending never auto-expires", () => {
  const o = baseOrder({
    walletMode: "managed",
    status: "settling",
    settlementUpdateId: "upd-1",
    counterLegOfferCid: "offer-1",
    quoteExpiresAt: 1
  });
  assert.equal(isOrderExpired(o, 999_999), false);
});

test("counter reissue cooldown blocks immediate reissue", () => {
  assert.equal(counterReissueCooldownElapsed(undefined), false);
  assert.equal(counterReissueCooldownElapsed(1000, 1050), false);
  assert.equal(counterReissueCooldownElapsed(1000, 1090), true);
});

test("loop fill and counter reissue command ids are deterministic", () => {
  assert.equal(loopFillCommandId("abc"), "canton-swap-fill-abc");
  assert.equal(loopCounterReissueCommandId("abc", 2), "canton-swap-counter-abc-2");
});

test("isRetriableLoopFillError detects transient fill failures", () => {
  assert.equal(isRetriableLoopFillError("user leg offer not visible on settlement receiver yet"), true);
  assert.equal(isRetriableLoopFillError("insufficient solver float"), false);
});

test("resolveCreateCantonSwapOrder: same id does not overwrite", () => {
  const existing = baseOrder({ id: "swap-1", status: "user_locked" });
  const incoming = {
    id: "swap-1",
    fromAsset: "CBTC" as const,
    toAsset: "CC" as const,
    inAmount: "9",
    outAmount: "99",
    minOut: "99",
    quoteExpiresAt: 9_999,
    userParty: "user::1",
    solverParty: "solver::1",
    walletMode: "loop" as const
  };
  const { order, isNew } = resolveCreateCantonSwapOrder(existing, incoming, 500);
  assert.equal(isNew, false);
  assert.equal(order.status, "user_locked");
  assert.equal(order.inAmount, "1");
});

test("resolveCreateCantonSwapOrder: rejects id owned by another party", () => {
  const existing = baseOrder({ id: "swap-1", userParty: "user::1" });
  const incoming = {
    id: "swap-1",
    fromAsset: "CBTC" as const,
    toAsset: "CC" as const,
    inAmount: "1",
    outAmount: "10",
    minOut: "10",
    quoteExpiresAt: 9_999,
    userParty: "user::2",
    solverParty: "solver::1",
    walletMode: "loop" as const
  };
  assert.throws(
    () => resolveCreateCantonSwapOrder(existing, incoming, 500),
    /another party/
  );
});
