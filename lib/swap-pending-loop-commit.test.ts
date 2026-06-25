import assert from "node:assert/strict";
import test from "node:test";

import {
  __setPendingLoopCommitStorageForTests,
  clearPendingLoopCommit,
  hasPendingHtlcSecret,
  recallPendingHtlcSecret,
  writePendingLoopCommit
} from "./swap-pending-loop-commit";

const ORDER_ID =
  "0x48ee425890483a42a78a8a178285300cfc5855065c385db2c2652dff3a55ddc5";

test("recallPendingHtlcSecret reads reverse HTLC secret from pending commit", () => {
  const store = new Map<string, string>();
  __setPendingLoopCommitStorageForTests({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    }
  });
  clearPendingLoopCommit();
  writePendingLoopCommit({
    flow: "reverse-htlc",
    hashLock: ORDER_ID,
    secret: "0xdeadbeef",
    userEvmAddress: "0xabc",
    userCantonParty: "party::1",
    wbtcAmount: "9857",
    cbtcAmount: "0.0001",
    userTimelock: 1_700_000_000,
    solverTimelock: 1_700_010_000
  });
  assert.equal(recallPendingHtlcSecret(ORDER_ID), "0xdeadbeef");
  assert.equal(hasPendingHtlcSecret(ORDER_ID), true);
  assert.equal(recallPendingHtlcSecret("0xother"), null);
  clearPendingLoopCommit();
  __setPendingLoopCommitStorageForTests(null);
});
