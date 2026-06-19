import assert from "node:assert/strict";
import { test } from "node:test";

import { isSolverProxyPathAllowed } from "./solver-proxy-allowlist";

test("solver proxy allows documented swap-api paths", () => {
  assert.equal(isSolverProxyPathAllowed(["health"]), true);
  assert.equal(isSolverProxyPathAllowed(["quote"]), true);
  assert.equal(isSolverProxyPathAllowed(["orders"]), true);
  assert.equal(isSolverProxyPathAllowed(["orders", "abc"]), true);
  assert.equal(isSolverProxyPathAllowed(["orders", "abc", "accepted"]), true);
  assert.equal(isSolverProxyPathAllowed(["orders", "abc", "refund"]), true);
});

test("solver proxy denies privileged or unknown paths", () => {
  assert.equal(isSolverProxyPathAllowed([]), false);
  assert.equal(isSolverProxyPathAllowed(["admin"]), false);
  assert.equal(isSolverProxyPathAllowed(["orders", "abc", "deliver"]), false);
});
