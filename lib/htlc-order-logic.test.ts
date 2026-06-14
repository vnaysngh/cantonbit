import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isSwapClaimable, filterHistoryOrders, isAbandonedSwapDraft } from "./htlc-order-logic";

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
