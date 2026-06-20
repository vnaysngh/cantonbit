import assert from "node:assert/strict";
import test from "node:test";

import { loopHtlcCollectsOranjNetworkFee } from "./loop-htlc-fee-policy";

test("loopHtlcCollectsOranjNetworkFee: forward only", () => {
  assert.equal(loopHtlcCollectsOranjNetworkFee("evm-to-canton"), true);
  assert.equal(loopHtlcCollectsOranjNetworkFee("canton-to-evm"), false);
});
