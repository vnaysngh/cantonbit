import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyLegChange,
  normalizeSwapLegs,
  resolveSwapKind,
  swapLegPickerDisabled
} from "./swap-leg";

test("cross-chain is WBTC ↔ CBTC only", () => {
  assert.equal(
    resolveSwapKind(
      { chain: "evm", token: "WBTC" },
      { chain: "canton", token: "CBTC" }
    ),
    "evm-to-canton"
  );
  assert.equal(
    resolveSwapKind(
      { chain: "evm", token: "WBTC" },
      { chain: "canton", token: "CC" }
    ),
    "invalid-cross-chain-canton"
  );
  assert.equal(
    resolveSwapKind(
      { chain: "canton", token: "CC" },
      { chain: "evm", token: "WBTC" }
    ),
    "invalid-cross-chain-canton"
  );
});

test("normalizeSwapLegs coerces cross-chain canton leg to CBTC", () => {
  const { pay, receive } = normalizeSwapLegs(
    { chain: "evm", token: "WBTC" },
    { chain: "canton", token: "CC" }
  );
  assert.equal(receive.chain, "canton");
  assert.equal(receive.token, "CBTC");

  const flipped = normalizeSwapLegs(
    { chain: "canton", token: "CC" },
    { chain: "evm", token: "WBTC" }
  );
  assert.equal(flipped.pay.token, "CBTC");
  assert.equal(flipped.pay.chain, "canton");
});

test("canton-to-canton keeps CC ↔ CBTC", () => {
  const { pay, receive } = normalizeSwapLegs(
    { chain: "canton", token: "CC" },
    { chain: "canton", token: "CBTC" }
  );
  assert.equal(pay.token, "CC");
  assert.equal(receive.token, "CBTC");
  assert.equal(resolveSwapKind(pay, receive), "canton-to-canton");
});

test("swapLegPickerDisabled blocks invalid cross-chain and same-side picks", () => {
  assert.equal(
    swapLegPickerDisabled(
      { chain: "canton", token: "CC" },
      { chain: "evm", token: "WBTC" }
    ),
    true
  );
  assert.equal(
    swapLegPickerDisabled(
      { chain: "evm", token: "WBTC" },
      { chain: "canton", token: "CC" }
    ),
    true
  );
  assert.equal(
    swapLegPickerDisabled(
      { chain: "canton", token: "CBTC" },
      { chain: "evm", token: "WBTC" }
    ),
    false
  );
  assert.equal(
    swapLegPickerDisabled(
      { chain: "canton", token: "CBTC" },
      { chain: "canton", token: "CBTC" }
    ),
    true
  );
  assert.equal(
    swapLegPickerDisabled(
      { chain: "evm", token: "WBTC" },
      { chain: "evm", token: "WBTC" }
    ),
    true
  );
});

test("applyLegChange coerces CC receive when paying WBTC", () => {
  const { receive } = applyLegChange(
    "receive",
    { chain: "canton", token: "CC" },
    { chain: "evm", token: "WBTC" },
    { chain: "canton", token: "CBTC" }
  );
  assert.equal(receive.token, "CBTC");
});
