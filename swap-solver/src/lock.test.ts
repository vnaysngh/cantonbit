import { test } from "node:test";
import assert from "node:assert/strict";

import { isActivelyLocked } from "./canton.js";

const NOW = "2026-06-05T12:00:00.000Z";

test("no lock → spendable (not locked)", () => {
  assert.equal(isActivelyLocked(null, NOW), false);
  assert.equal(isActivelyLocked(undefined, NOW), false);
});

test("indefinite lock (no expiry fields) → locked", () => {
  // What a fresh allocation lock looks like on the live cBTC registry.
  assert.equal(isActivelyLocked({ expiresAt: null, expiresAfter: null }, NOW), true);
  assert.equal(isActivelyLocked({}, NOW), true);
});

test("lock expiring in the FUTURE → still locked", () => {
  assert.equal(isActivelyLocked({ expiresAt: "2026-06-05T13:00:00.000Z" }, NOW), true);
});

test("lock that already EXPIRED → spendable (registry allows expired-lock inputs)", () => {
  assert.equal(isActivelyLocked({ expiresAt: "2026-06-05T11:00:00.000Z" }, NOW), false);
});

test("relative expiry (expiresAfter) we can't resolve → conservatively locked", () => {
  assert.equal(isActivelyLocked({ expiresAfter: "some-relative-ref" }, NOW), true);
});
