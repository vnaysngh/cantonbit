import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOutputFee,
  parsePlatformFeeBps,
  quoteGrossOutUnits,
  quoteOutUnits
} from "./htlc-quote-math";

test("cbtc → wbtc applies price and fee like server quote", () => {
  const cbtcIn = 9_479n; // 0.00009479 CBTC
  const price8 = 99_814_127n; // ~0.99814127 BTC per WBTC
  const out = quoteOutUnits("canton-to-evm", cbtcIn, price8, 100);
  assert.equal(out, 9_402n);
});

test("wbtc → cbtc applies price and fee", () => {
  const wbtcIn = 10_000n;
  const price8 = 99_500_000n;
  const gross = quoteGrossOutUnits("evm-to-canton", wbtcIn, price8);
  assert.equal(gross, 9_950n);
  assert.equal(applyOutputFee(gross, 100), 9_851n);
});

test("platform fee config rejects unsafe or malformed values", () => {
  assert.equal(parsePlatformFeeBps(undefined, 100), 100);
  assert.equal(parsePlatformFeeBps("250", 100), 250);
  assert.throws(() => parsePlatformFeeBps("NaN", 100));
  assert.throws(() => parsePlatformFeeBps("1.5", 100));
  assert.throws(() => parsePlatformFeeBps("-1", 100));
  assert.throws(() => parsePlatformFeeBps("10001", 100));
  assert.throws(() => applyOutputFee(1_000n, Number.NaN));
});
