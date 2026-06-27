import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isSwapClaimable, filterHistoryOrders, isAbandonedSwapDraft, resolveCreateOrder, shouldPollOrderOnOrdersPage, htlcUserWbtcClaimTx, htlcReverseSolverRetakeTx, reverseZeroLockReconcileOutcome, isRefundMainCantonStatusEligible, isReverseMainExpiredSweepCandidate } from "./htlc-order-logic";
import type { SwapOrder } from "./htlc-types";

const base = {
  direction: "evm-to-canton" as const,
  counterMode: "managed" as const,
  revealedPreimage: undefined,
};

test("reverseZeroLockReconcileOutcome: C-02 solver retake must not advance", () => {
  assert.equal(reverseZeroLockReconcileOutcome(false), "continue");
});

test("reverseZeroLockReconcileOutcome: user Claimed advances to counter_claimed", () => {
  assert.equal(reverseZeroLockReconcileOutcome(true), "counter_claimed");
});

test("isSwapClaimable: counter_locked managed forward", () => {
  assert.equal(isSwapClaimable({ ...base, status: "counter_locked" }), true);
});

test("isSwapClaimable: loop forward at main_locked", () => {
  assert.equal(
    isSwapClaimable({ ...base, status: "main_locked", counterMode: "loop" }),
    true,
  );
});

test("isSwapClaimable: managed forward at main_locked is not claimable", () => {
  assert.equal(isSwapClaimable({ ...base, status: "main_locked" }), false);
});

test("isSwapClaimable: revealed preimage blocks claim", () => {
  assert.equal(
    isSwapClaimable({
      ...base,
      status: "counter_locked",
      revealedPreimage: ("0x" + "aa".repeat(32)) as `0x${string}`,
    }),
    false,
  );
});

test("isAbandonedSwapDraft: accepted forward with no EVM lock", () => {
  assert.equal(
    isAbandonedSwapDraft({ direction: "evm-to-canton", status: "accepted", mainLockTx: undefined }),
    true,
  );
  assert.equal(
    isAbandonedSwapDraft({ direction: "evm-to-canton", status: "accepted", mainLockTx: "0xabc" }),
    false,
  );
});

test("filterHistoryOrders: drops abandoned drafts and foreign EVM wallets", () => {
  const orders = [
    { direction: "evm-to-canton" as const, status: "accepted" as const, mainLockTx: undefined, userEvmAddress: "0xaaa" },
    { direction: "evm-to-canton" as const, status: "main_claimed" as const, mainLockTx: "0xlock", userEvmAddress: "0xbbb" },
    { direction: "evm-to-canton" as const, status: "main_claimed" as const, mainLockTx: "0xlock", userEvmAddress: "0xaaa" },
  ];
  assert.equal(filterHistoryOrders(orders).length, 2);
  assert.equal(filterHistoryOrders(orders, { userEvmAddress: "0xaaa" }).length, 1);
});

test("filterHistoryOrders: drops smoke automation orders", () => {
  const orders = [
    {
      id: "smoke-loop-rev-abc",
      direction: "canton-to-evm" as const,
      status: "main_locked" as const,
      mainLockTx: "0xlock",
      userEvmAddress: "0xaaa",
    },
    {
      id: "0x" + "ab".repeat(32),
      direction: "canton-to-evm" as const,
      status: "main_locked" as const,
      mainLockTx: "0xlock",
      userEvmAddress: "0xaaa",
    },
  ];
  assert.equal(filterHistoryOrders(orders).length, 1);
  assert.equal(filterHistoryOrders(orders)[0]?.id, orders[1]?.id);
});

test("shouldPollOrderOnOrdersPage skips canton-swap open intents", () => {
  assert.equal(
    shouldPollOrderOnOrdersPage({
      id: "abc",
      direction: "canton-swap",
      status: "open"
    }),
    false
  );
  assert.equal(
    shouldPollOrderOnOrdersPage({
      id: "abc",
      direction: "canton-swap",
      status: "user_locked"
    }),
    true
  );
});

test("shouldPollOrderOnOrdersPage skips abandoned HTLC drafts", () => {
  assert.equal(
    shouldPollOrderOnOrdersPage({
      id: "0xabc",
      direction: "evm-to-canton",
      status: "accepted"
    }),
    false
  );
});

test("filterHistoryOrders: hides other EVM wallets when filter is set", () => {
  const orders = [
    {
      direction: "evm-to-canton" as const,
      status: "main_claimed" as const,
      mainLockTx: "0xlock",
      userEvmAddress: "0xbbb",
    },
    {
      direction: "evm-to-canton" as const,
      status: "main_claimed" as const,
      mainLockTx: "0xlock",
      userEvmAddress: "0xaaa",
    },
  ];
  assert.equal(
    filterHistoryOrders(orders, { userEvmAddress: "0xaaa" }).length,
    1
  );
});

test("htlcUserWbtcClaimTx: reverse prefers mainClaimTx", () => {
  const tx = "0x" + "ab".repeat(32);
  const preimage = ("0x" + "cc".repeat(32)) as `0x${string}`;
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      mainClaimTx: tx,
      counterClaimUpdateId: "0x" + "cd".repeat(32),
      status: "main_claimed",
      revealedPreimage: preimage
    }),
    tx
  );
});

test("htlcUserWbtcClaimTx: reverse legacy counterClaimUpdateId", () => {
  const tx = "0x" + "cd".repeat(32);
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      mainClaimTx: undefined,
      counterClaimUpdateId: tx,
      status: "main_claimed"
    }),
    tx
  );
});

test("htlcUserWbtcClaimTx: reverse solver retake is not a user WBTC claim", () => {
  const retake = "0x" + "ef".repeat(32);
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      mainClaimTx: retake,
      status: "failed",
      revealedPreimage: undefined
    }),
    undefined
  );
  assert.equal(
    htlcReverseSolverRetakeTx({
      direction: "canton-to-evm",
      mainClaimTx: retake,
      status: "failed",
      revealedPreimage: undefined
    }),
    retake
  );
});

test("htlcUserWbtcClaimTx: reverse user claim path requires reveal or terminal claim status", () => {
  const claim = "0x" + "11".repeat(32);
  const preimage = ("0x" + "22".repeat(32)) as `0x${string}`;
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      mainClaimTx: claim,
      status: "main_claimed",
      revealedPreimage: preimage
    }),
    claim
  );
});

test("resolveCreateOrder rejects id owned by another party", () => {
  const existing: SwapOrder = {
    id: "0xhash",
    direction: "evm-to-canton",
    status: "open",
    hashLock: ("0x" + "ab".repeat(32)) as `0x${string}`,
    userTimelock: 9999,
    userCantonParty: "user::1",
    solverCantonParty: "solver::1",
    solverTimelock: 8888,
    createdAt: 100
  };
  const incoming = {
    ...existing,
    userCantonParty: "user::2"
  };
  assert.throws(
    () => resolveCreateOrder(existing, incoming, 200),
    /another party/
  );
});

test("isRefundMainCantonStatusEligible accepts active reverse statuses", () => {
  for (const status of [
    "main_locked",
    "counter_locking",
    "counter_locked",
    "counter_claimed",
    "refunding"
  ] as const) {
    assert.equal(isRefundMainCantonStatusEligible({ status }), true);
  }
});

test("isRefundMainCantonStatusEligible accepts failed after solver retake", () => {
  const tx = "0x" + "ab".repeat(32);
  assert.equal(
    isRefundMainCantonStatusEligible({
      status: "failed",
      mainClaimTx: tx,
      revealedPreimage: undefined
    }),
    true
  );
});

test("isRefundMainCantonStatusEligible rejects bare failed rows", () => {
  assert.equal(isRefundMainCantonStatusEligible({ status: "failed" }), false);
  assert.equal(
    isRefundMainCantonStatusEligible({
      status: "failed",
      mainClaimTx: "0x" + "ab".repeat(32),
      revealedPreimage: ("0x" + "cd".repeat(32)) as `0x${string}`
    }),
    false
  );
});

test("isReverseMainExpiredSweepCandidate includes retake-recorded failed rows", () => {
  const tx = "0x" + "ab".repeat(32);
  const order = {
    direction: "canton-to-evm" as const,
    counterMode: "managed" as const,
    htlcCid: "htlc-cid",
    revealedPreimage: undefined,
    status: "failed" as const,
    mainClaimTx: tx,
    userTimelock: 1000
  };
  assert.equal(isReverseMainExpiredSweepCandidate(order, 1000), true);
  assert.equal(isReverseMainExpiredSweepCandidate(order, 999), false);
});
