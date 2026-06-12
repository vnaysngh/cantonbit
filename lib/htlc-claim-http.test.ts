import { strict as assert } from "node:assert";
import { test } from "node:test";

import { htlcClaimErrorStatus } from "./htlc-claim-http";

test("htlcClaimErrorStatus maps preimage errors to 400", () => {
  assert.equal(htlcClaimErrorStatus("invalid preimage"), 400);
  assert.equal(htlcClaimErrorStatus("missing preimage"), 400);
});

test("htlcClaimErrorStatus maps EVM margin / state errors to 409", () => {
  assert.equal(
    htlcClaimErrorStatus("EVM lock expires too soon for the solver to claim safely"),
    409,
  );
  assert.equal(htlcClaimErrorStatus("counter not locked (accepted)"), 409);
});

test("htlcClaimErrorStatus defaults unknown errors to 500", () => {
  assert.equal(htlcClaimErrorStatus("database unavailable"), 500);
});
