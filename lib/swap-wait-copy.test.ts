import assert from "node:assert/strict";
import test from "node:test";

import {
  SWAP_WAIT_EXTENDED_AFTER_SECONDS,
  swapWaitHint,
  swapWaitPrimaryLabel,
  swapWaitTerminalMessage
} from "./swap-wait-copy";

test("swapWaitPrimaryLabel escalates after extended threshold", () => {
  assert.equal(
    swapWaitPrimaryLabel({ elapsedSec: 0, mode: "solver" }),
    "Waiting for solver…"
  );
  assert.equal(
    swapWaitPrimaryLabel({
      elapsedSec: SWAP_WAIT_EXTENDED_AFTER_SECONDS,
      mode: "solver"
    }),
    "Still finding a solver…"
  );
  assert.equal(
    swapWaitPrimaryLabel({ elapsedSec: 10, mode: "locking" }),
    "Locking CBTC…"
  );
});

test("swapWaitHint only after extended threshold", () => {
  assert.equal(swapWaitHint(SWAP_WAIT_EXTENDED_AFTER_SECONDS - 1), null);
  assert.match(
    swapWaitHint(SWAP_WAIT_EXTENDED_AFTER_SECONDS) ?? "",
    /Orders page/
  );
});

test("swapWaitTerminalMessage covers terminal statuses", () => {
  assert.match(swapWaitTerminalMessage("refunded"), /refunded/i);
  assert.match(swapWaitTerminalMessage("failed"), /Orders/i);
});
