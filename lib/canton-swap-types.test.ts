import assert from "node:assert/strict";
import test from "node:test";

import { isCantonSwapMvpPair } from "./canton-swap-types";

test("isCantonSwapMvpPair accepts CBTC↔CC", () => {
  assert.equal(isCantonSwapMvpPair("CBTC", "CC"), true);
  assert.equal(isCantonSwapMvpPair("CC", "CBTC"), true);
});

test("isCantonSwapMvpPair rejects same asset and non-MVP assets", () => {
  assert.equal(isCantonSwapMvpPair("CBTC", "CBTC"), false);
  assert.equal(isCantonSwapMvpPair("CBTC", "USDCX"), false);
});
