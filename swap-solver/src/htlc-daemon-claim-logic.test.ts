import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  shouldAttemptPostRevealEvmClaim,
  shouldDeferEvmClaimForPreRevealMargin
} from "./htlc-daemon-claim-logic";

test("shouldDeferEvmClaimForPreRevealMargin blocks when unlock is too soon", () => {
  assert.equal(
    shouldDeferEvmClaimForPreRevealMargin({
      unlockTimeSec: 1000,
      nowSec: 500,
      marginSec: 600
    }),
    true
  );
  assert.equal(
    shouldDeferEvmClaimForPreRevealMargin({
      unlockTimeSec: 2000,
      nowSec: 500,
      marginSec: 600
    }),
    false
  );
});

test("shouldAttemptPostRevealEvmClaim always attempts claim", () => {
  assert.equal(shouldAttemptPostRevealEvmClaim(), true);
});
