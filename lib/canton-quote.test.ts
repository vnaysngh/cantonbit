import { test } from "node:test";
import assert from "node:assert/strict";

import { fromBaseUnits, toBaseUnits } from "./amount-units";
import { isCantonPair, enabledCantonPairs } from "./canton-assets";
import { timelocksFromExpirationCanton, MIN_GAP_CANTON } from "./htlc-timelock";

test("amount-units round-trip CBTC 8dp", () => {
  const u = toBaseUnits("0.001", 8);
  assert.equal(u, 100000n);
  assert.equal(fromBaseUnits(u, 8), "0.001");
});

test("enabled pairs include CBTC/USDCX when USDCX configured", () => {
  const pairs = enabledCantonPairs();
  if (process.env.CANTON_USDCX_ADMIN || process.env.NEXT_PUBLIC_CANTON_USDCX_ADMIN) {
    assert.ok(
      pairs.some(([a, b]) => (a === "CBTC" && b === "USDCX") || (a === "USDCX" && b === "CBTC"))
    );
  }
});

test("isCantonPair rejects same asset", () => {
  assert.equal(isCantonPair("CBTC", "CBTC"), false);
});

test("timelocksFromExpirationCanton respects MIN_GAP_CANTON", () => {
  const now = 1_700_000_000;
  const { userTimelock, solverTimelock } = timelocksFromExpirationCanton(
    now,
    4 * 60 * 60
  );
  assert.ok(userTimelock - solverTimelock >= MIN_GAP_CANTON);
});
