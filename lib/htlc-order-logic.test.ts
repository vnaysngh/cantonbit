import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isSwapClaimable } from "./htlc-order-logic";

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
