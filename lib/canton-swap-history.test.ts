import assert from "node:assert/strict";
import test from "node:test";

import {
  cantonSwapPayReceive,
  isCantonSwapHistoryRow,
  mapCantonSwapToHistoryRow,
  needsCantonSwapCounterAccept
} from "./canton-swap-history";
import type { CantonSwapOrder } from "./canton-swap-types";

const baseOrder: CantonSwapOrder = {
  id: "swap-1",
  status: "user_locked",
  fromAsset: "CBTC",
  toAsset: "CC",
  inAmount: "0.001",
  outAmount: "10",
  minOut: "10",
  quoteExpiresAt: 9999999999,
  userParty: "user::1",
  solverParty: "solver::1",
  walletMode: "loop",
  counterLegOfferCid: "offer-123",
  createdAt: 1_000_000
};

test("mapCantonSwapToHistoryRow sets canton-swap direction", () => {
  const row = mapCantonSwapToHistoryRow(baseOrder);
  assert.equal(row.direction, "canton-swap");
  assert.equal(isCantonSwapHistoryRow(row), true);
  assert.deepEqual(cantonSwapPayReceive(row), {
    pay: "0.001 CBTC",
    receive: "10 CC"
  });
});

test("needsCantonSwapCounterAccept when loop fill pending accept", () => {
  const row = mapCantonSwapToHistoryRow({
    ...baseOrder,
    settlementUpdateId: "update-1",
    failureReason: "Counter leg pending Loop accept — user must accept incoming transfer"
  });
  assert.equal(needsCantonSwapCounterAccept(row), true);
});

test("needsCantonSwapCounterAccept false without settlement update", () => {
  const row = mapCantonSwapToHistoryRow({
    ...baseOrder,
    settlementUpdateId: undefined
  });
  assert.equal(needsCantonSwapCounterAccept(row), false);
});

test("needsCantonSwapCounterAccept true for filled row with pending counter offer", () => {
  const row = mapCantonSwapToHistoryRow({
    ...baseOrder,
    status: "filled",
    settlementUpdateId: "update-1"
  });
  assert.equal(needsCantonSwapCounterAccept(row), true);
});

test("needsCantonSwapCounterAccept false when filled counter offer was accepted", () => {
  const row = mapCantonSwapToHistoryRow({
    ...baseOrder,
    status: "filled",
    settlementUpdateId: "update-1",
    counterReceiptUpdateId: "receipt-1"
  });
  assert.equal(needsCantonSwapCounterAccept(row), false);
});
