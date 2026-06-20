import assert from "node:assert/strict";
import test from "node:test";

import { formatSettlementError } from "./swap-settlement-messages";

test("formatSettlementError maps registry failures", () => {
  const msg = formatSettlementError(
    'TransferFactory registry call failed (502): { "error" : "Failed to reach consensus from 9 Scan nodes" }'
  );
  assert.match(msg, /safe/i);
  assert.match(msg, /retry/i);
});
