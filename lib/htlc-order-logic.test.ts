import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isSwapClaimable, filterHistoryOrders, isAbandonedSwapDraft, resolveCreateOrder, isEvmTxHash, htlcUserWbtcClaimTx, htlcSolverWbtcClaimTx, htlcCantonClaimUpdateId } from "./htlc-order-logic";
import type { SwapOrder } from "./htlc-types";

const base = {
  direction: "evm-to-canton" as const,
  counterMode: "managed" as const,
  revealedPreimage: undefined,
};

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

const evmTx = ("0x" + "cd".repeat(32)) as `0x${string}`;
const cantonUpdate = "1220deadbeef";

test("isEvmTxHash accepts 32-byte hex", () => {
  assert.equal(isEvmTxHash(evmTx), true);
  assert.equal(isEvmTxHash(cantonUpdate), false);
});

test("htlcUserWbtcClaimTx: reverse reads mainClaimTx or legacy counter field", () => {
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      mainClaimTx: evmTx
    }),
    evmTx
  );
  assert.equal(
    htlcUserWbtcClaimTx({
      direction: "canton-to-evm",
      counterClaimUpdateId: evmTx
    }),
    evmTx
  );
  assert.equal(
    htlcUserWbtcClaimTx({ direction: "evm-to-canton", mainClaimTx: evmTx }),
    undefined
  );
});

test("htlcSolverWbtcClaimTx: forward only", () => {
  assert.equal(
    htlcSolverWbtcClaimTx({ direction: "evm-to-canton", mainClaimTx: evmTx }),
    evmTx
  );
  assert.equal(
    htlcSolverWbtcClaimTx({ direction: "canton-to-evm", mainClaimTx: evmTx }),
    undefined
  );
});

test("htlcCantonClaimUpdateId: filters mis-filed EVM hash on reverse", () => {
  assert.equal(
    htlcCantonClaimUpdateId({
      direction: "canton-to-evm",
      counterClaimUpdateId: evmTx
    }),
    undefined
  );
  assert.equal(
    htlcCantonClaimUpdateId({
      direction: "canton-to-evm",
      counterClaimUpdateId: cantonUpdate
    }),
    cantonUpdate
  );
  assert.equal(
    htlcCantonClaimUpdateId({
      direction: "evm-to-canton",
      counterClaimUpdateId: cantonUpdate
    }),
    cantonUpdate
  );
});
