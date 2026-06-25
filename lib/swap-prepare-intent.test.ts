import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertValidPrepareCreatedAt,
  PREPARE_INTENT_MAX_CLOCK_SKEW_SECONDS,
  PREPARE_INTENT_TTL_SECONDS
} from "./swap-prepare-intent";

test("assertValidPrepareCreatedAt rejects future timestamps", () => {
  const now = 1_000_000;
  assert.throws(
    () =>
      assertValidPrepareCreatedAt(
        now + PREPARE_INTENT_MAX_CLOCK_SKEW_SECONDS + 1,
        now
      ),
    /future/
  );
});

test("assertValidPrepareCreatedAt rejects expired intents", () => {
  const now = 1_000_000;
  assert.throws(
    () =>
      assertValidPrepareCreatedAt(now - PREPARE_INTENT_TTL_SECONDS - 1, now),
    /expired/
  );
});

test("assertValidPrepareCreatedAt accepts recent server-issued timestamps", () => {
  const now = 1_000_000;
  assert.equal(assertValidPrepareCreatedAt(now - 30, now), now - 30);
});
