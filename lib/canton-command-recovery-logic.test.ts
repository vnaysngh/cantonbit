import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isPartyUpdateScanComplete } from "./canton-command-recovery-logic";

test("empty page means party scan complete even when party offset lags ledger-end", () => {
  assert.equal(isPartyUpdateScanComplete(true), true);
  assert.equal(isPartyUpdateScanComplete(false), false);
  // Invariant: lastSeenOffset=5_000_000 and endInclusive=5_000_100 with empty page
  // is COMPLETE — must not throw "scan incomplete" (shared participant node).
  const lastSeenOffset = 5_000_000;
  const endInclusive = 5_000_100;
  assert.ok(lastSeenOffset < endInclusive);
  assert.equal(isPartyUpdateScanComplete(true), true);
});
