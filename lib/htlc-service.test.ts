import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveCreateOrder } from "./htlc-order-logic";
import type { SwapOrder } from "./htlc-types";

function baseOrder(over: Partial<SwapOrder> = {}): Omit<SwapOrder, "status" | "createdAt"> {
  return {
    id: "0xAAA",
    direction: "evm-to-canton",
    hashLock: "0xAAA",
    userEvmAddress: "0xuser",
    solverEvmAddress: "0xsolver",
    wbtcAmount: "100",
    userTimelock: 2000,
    userCantonParty: "user::ns",
    solverCantonParty: "solver::ns",
    cbtcAmount: "0.001",
    solverTimelock: 1000,
    ...over,
  };
}

// REGRESSION (security audit 2026-06-12): a re-POST with the SAME id must NOT
// overwrite a live order's terms/status. createOrder is no-overwrite + idempotent.
test("resolveCreateOrder: same id does NOT overwrite a live order", () => {
  // An order already exists, advanced to main_locked with amount 100.
  const existing: SwapOrder = { ...baseOrder({ wbtcAmount: "100" }), status: "main_locked", createdAt: 111 };

  // Attacker/retry: same id, DIFFERENT terms.
  const incoming = baseOrder({ wbtcAmount: "999", cbtcAmount: "9.99" });
  const { order, isNew } = resolveCreateOrder(existing, incoming, 222);

  assert.equal(isNew, false, "must not be treated as new");
  assert.equal(order.status, "main_locked", "status must not reset to open");
  assert.equal(order.wbtcAmount, "100", "amount must not be overwritten");
  assert.equal(order.cbtcAmount, "0.001", "cbtc amount must not be overwritten");
  assert.equal(order.createdAt, 111, "createdAt must not change");
});

test("resolveCreateOrder: a brand-new id creates normally", () => {
  const { order, isNew } = resolveCreateOrder(undefined, baseOrder({ id: "0xBBB" }), 333);
  assert.equal(isNew, true);
  assert.equal(order.id, "0xBBB");
  assert.equal(order.status, "open");
  assert.equal(order.createdAt, 333);
});
