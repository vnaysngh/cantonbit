import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertEvmLockSafeForReveal,
  EVM_CLAIM_MARGIN_SECONDS,
} from "./htlc-evm-lock-guard";

const SOLVER = "0x0b95ec21579aee6ef7b712976bd86689d68b5a08";
const NOW = 1_700_000_000;

const req = {
  wbtcAmount: "100000",
  solverEvmAddress: SOLVER,
  expectedWbtcAddress: "0x8d587e55236d1d4898e85711f709e53e657413ee",
};

function safeLock(over: Partial<{ unlockTime: number; amount: bigint; tokenAddress: string; receiver: string }> = {}) {
  return {
    unlockTime: NOW + EVM_CLAIM_MARGIN_SECONDS + 60,
    amount: 100_000n,
    tokenAddress: "0x8d587e55236d1d4898e85711f709e53e657413ee",
    receiver: SOLVER,
    ...over,
  };
}

// REGRESSION (security review 2026-06-12): claimCounterAsBackend must reject the
// same near-expiry reveals as claimCounter — both call verifyEvmLock → this guard.
test("assertEvmLockSafeForReveal rejects near-expiry lock (solver robbery)", () => {
  assert.throws(
    () =>
      assertEvmLockSafeForReveal(
        safeLock({ unlockTime: NOW + EVM_CLAIM_MARGIN_SECONDS - 1 }),
        req,
        NOW,
      ),
    /expires too soon/,
  );
});

test("assertEvmLockSafeForReveal accepts lock with full margin", () => {
  assert.doesNotThrow(() =>
    assertEvmLockSafeForReveal(safeLock(), req, NOW),
  );
});

test("assertEvmLockSafeForReveal rejects missing lock (zero amount)", () => {
  assert.throws(
    () => assertEvmLockSafeForReveal(safeLock({ amount: 0n }), req, NOW),
    /not found/,
  );
});

test("assertEvmLockSafeForReveal rejects under-funded lock", () => {
  assert.throws(
    () => assertEvmLockSafeForReveal(safeLock({ amount: 50_000n }), req, NOW),
    /too small/,
  );
});

test("assertEvmLockSafeForReveal rejects wrong receiver", () => {
  assert.throws(
    () =>
      assertEvmLockSafeForReveal(
        safeLock({ receiver: "0x0000000000000000000000000000000000000001" }),
        req,
        NOW,
      ),
    /receiver is not the solver/,
  );
});

test("assertEvmLockSafeForReveal rejects unlockTime mismatch with order timelock", () => {
  assert.throws(
    () =>
      assertEvmLockSafeForReveal(
        safeLock({ unlockTime: NOW + EVM_CLAIM_MARGIN_SECONDS + 3600 }),
        { ...req, expectedUserTimelock: NOW + 120 },
        NOW
      ),
    /does not match order userTimelock/
  );
});

test("assertEvmLockSafeForReveal accepts bound userTimelock within tolerance", () => {
  const userTimelock = NOW + EVM_CLAIM_MARGIN_SECONDS + 300;
  assert.doesNotThrow(() =>
    assertEvmLockSafeForReveal(
      safeLock({ unlockTime: userTimelock + 30 }),
      { ...req, expectedUserTimelock: userTimelock },
      NOW
    )
  );
});

test("assertEvmLockSafeForReveal rejects non-WBTC token", () => {
  assert.throws(
    () =>
      assertEvmLockSafeForReveal(
        safeLock({ tokenAddress: "0x0000000000000000000000000000000000000001" }),
        req,
        NOW
      ),
    /not canonical WBTC/
  );
});
