import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertEvmLockSafeForReveal,
  EVM_CLAIM_MARGIN_SECONDS,
} from "./htlc-evm-lock-guard";

const SOLVER = "0x0b95ec21579aee6ef7b712976bd86689d68b5a08";
const NOW = 1_700_000_000;

const req = { wbtcAmount: "100000", solverEvmAddress: SOLVER };

function safeLock(over: Partial<{ unlockTime: number; amount: bigint; receiver: string }> = {}) {
  return {
    unlockTime: NOW + EVM_CLAIM_MARGIN_SECONDS + 60,
    amount: 100_000n,
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
