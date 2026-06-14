import assert from "node:assert/strict";
import test from "node:test";

import type { SwapOrder } from "./htlc-types";
import { htlcStepIndex } from "./htlc-track-order";

function forwardOrder(status: SwapOrder["status"]): SwapOrder {
  return {
    id: "0xabc",
    direction: "evm-to-canton",
    status,
    hashLock: "0xabc",
    userTimelock: 9999999999,
    userCantonParty: "user::1",
    solverCantonParty: "solver::1",
    solverTimelock: 9999999999,
    createdAt: 1_000_000
  };
}

test("htlcStepIndex forward: progresses through lock and complete", () => {
  assert.equal(htlcStepIndex(forwardOrder("accepted")), 0);
  assert.equal(htlcStepIndex(forwardOrder("main_locked")), 1);
  assert.equal(htlcStepIndex(forwardOrder("counter_locked")), 1);
  assert.equal(htlcStepIndex(forwardOrder("main_claimed")), 2);
});
