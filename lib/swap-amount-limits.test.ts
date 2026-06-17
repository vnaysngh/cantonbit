import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkSwapPayAmountLimit,
  MAX_SWAP_CBTC,
  MAX_SWAP_CC
} from "./swap-amount-limits";

test("allows amounts at or below caps", () => {
  assert.equal(checkSwapPayAmountLimit("CC", "200").ok, true);
  assert.equal(checkSwapPayAmountLimit("CC", "199.999").ok, true);
  assert.equal(checkSwapPayAmountLimit("CBTC", "0.0001").ok, true);
  assert.equal(checkSwapPayAmountLimit("WBTC", "0.0001").ok, true);
});

test("rejects amounts above caps with asset-specific message", () => {
  const cc = checkSwapPayAmountLimit("CC", "200.0000001");
  assert.equal(cc.ok, false);
  if (!cc.ok) assert.match(cc.message, new RegExp(MAX_SWAP_CC));

  const cbtc = checkSwapPayAmountLimit("CBTC", "0.00010001");
  assert.equal(cbtc.ok, false);
  if (!cbtc.ok) assert.match(cbtc.message, new RegExp(MAX_SWAP_CBTC.replace(".", "\\.")));
});
