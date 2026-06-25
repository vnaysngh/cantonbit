import assert from "node:assert/strict";
import test from "node:test";

import {
  __setPendingLoopCommitStorageForTests,
  canReconnectReverseLoopCommit,
  clearLegacyPendingLoopCommitIfMatched,
  clearPendingLoopCommit,
  hasPendingLoopIntent,
  listPendingLoopCommits,
  patchPendingLoopCommit,
  readPendingLoopCommitByKey,
  recallPendingHtlcSecret,
  writePendingLoopCommit
} from "./swap-pending-loop-commit";

const ORDER_ID =
  "0x48ee425890483a42a78a8a178285300cfc5855065c385db2c2652dff3a55ddc5";

function futureTimelocks() {
  const userTimelock = Math.floor(Date.now() / 1000) + 7200;
  return { userTimelock, solverTimelock: userTimelock + 3600 };
}

function memoryStore(): Map<string, string> {
  return new Map<string, string>();
}

test("localStorage pending intents persist without plaintext secret", () => {
  const ls = memoryStore();
  const ss = memoryStore();
  __setPendingLoopCommitStorageForTests({
    localStorage: {
      getItem: (k) => ls.get(k) ?? null,
      setItem: (k, v) => {
        ls.set(k, v);
      },
      removeItem: (k) => {
        ls.delete(k);
      }
    },
    sessionStorage: {
      getItem: (k) => ss.get(k) ?? null,
      setItem: (k, v) => {
        ss.set(k, v);
      },
      removeItem: (k) => {
        ss.delete(k);
      }
    }
  });

  clearPendingLoopCommit();
  const { userTimelock, solverTimelock } = futureTimelocks();
  writePendingLoopCommit({
    flow: "reverse-htlc",
    hashLock: ORDER_ID,
    userEvmAddress: "0xabc",
    userCantonParty: "party::1",
    wbtcAmount: "9857",
    cbtcAmount: "0.0001",
    userTimelock,
    solverTimelock,
    submitUpdateId: "update-1",
    createdAt: Date.now()
  });

  assert.equal(hasPendingLoopIntent(ORDER_ID), true);
  assert.equal(recallPendingHtlcSecret(ORDER_ID), null);
  const pending = readPendingLoopCommitByKey(ORDER_ID);
  assert.equal(pending?.flow, "reverse-htlc");
  assert.equal(pending?.submitUpdateId, "update-1");
  assert.equal(listPendingLoopCommits().length, 1);
  assert.equal(
    canReconnectReverseLoopCommit(ORDER_ID, {
      direction: "canton-to-evm",
      counterMode: "loop",
      status: "accepted"
    }),
    true
  );

  clearPendingLoopCommit(ORDER_ID);
  assert.equal(hasPendingLoopIntent(ORDER_ID), false);
  __setPendingLoopCommitStorageForTests({});
});

test("legacy sessionStorage secret is readable until migrated", () => {
  const ls = memoryStore();
  const ss = memoryStore();
  __setPendingLoopCommitStorageForTests({
    localStorage: {
      getItem: (k) => ls.get(k) ?? null,
      setItem: (k, v) => {
        ls.set(k, v);
      },
      removeItem: (k) => {
        ls.delete(k);
      }
    },
    sessionStorage: {
      getItem: (k) => ss.get(k) ?? null,
      setItem: (k, v) => {
        ss.set(k, v);
      },
      removeItem: (k) => {
        ss.delete(k);
      }
    }
  });

  const { userTimelock, solverTimelock } = futureTimelocks();
  ss.set(
    "oranjswap.pendingLoopCommit",
    JSON.stringify({
      flow: "reverse-htlc",
      hashLock: ORDER_ID,
      secret: "0xdeadbeef",
      userEvmAddress: "0xabc",
      userCantonParty: "party::1",
      wbtcAmount: "9857",
      cbtcAmount: "0.0001",
      userTimelock,
      solverTimelock
    })
  );

  assert.equal(recallPendingHtlcSecret(ORDER_ID), "0xdeadbeef");
  writePendingLoopCommit({
    flow: "reverse-htlc",
    hashLock: ORDER_ID,
    userEvmAddress: "0xabc",
    userCantonParty: "party::1",
    wbtcAmount: "9857",
    cbtcAmount: "0.0001",
    userTimelock,
    solverTimelock
  });
  assert.equal(ss.has("oranjswap.pendingLoopCommit"), true);
  assert.equal(recallPendingHtlcSecret(ORDER_ID), "0xdeadbeef");
  assert.equal(hasPendingLoopIntent(ORDER_ID), true);
  clearLegacyPendingLoopCommitIfMatched(ORDER_ID);
  assert.equal(recallPendingHtlcSecret(ORDER_ID), null);

  clearPendingLoopCommit();
  __setPendingLoopCommitStorageForTests({});
});

test("hasPendingLoopIntent does not destroy legacy session secret", () => {
  const ls = memoryStore();
  const ss = memoryStore();
  __setPendingLoopCommitStorageForTests({
    localStorage: {
      getItem: (k) => ls.get(k) ?? null,
      setItem: (k, v) => {
        ls.set(k, v);
      },
      removeItem: (k) => {
        ls.delete(k);
      }
    },
    sessionStorage: {
      getItem: (k) => ss.get(k) ?? null,
      setItem: (k, v) => {
        ss.set(k, v);
      },
      removeItem: (k) => {
        ss.delete(k);
      }
    }
  });

  const { userTimelock, solverTimelock } = futureTimelocks();
  ss.set(
    "oranjswap.pendingLoopCommit",
    JSON.stringify({
      flow: "reverse-htlc",
      hashLock: ORDER_ID,
      secret: "0xdeadbeef",
      userEvmAddress: "0xabc",
      userCantonParty: "party::1",
      wbtcAmount: "9857",
      cbtcAmount: "0.0001",
      userTimelock,
      solverTimelock
    })
  );

  assert.equal(hasPendingLoopIntent(ORDER_ID), true);
  assert.equal(recallPendingHtlcSecret(ORDER_ID), "0xdeadbeef");

  clearPendingLoopCommit();
  __setPendingLoopCommitStorageForTests({});
});

test("patchPendingLoopCommit merges into latest record for flow", () => {
  const ls = memoryStore();
  __setPendingLoopCommitStorageForTests({
    localStorage: {
      getItem: (k) => ls.get(k) ?? null,
      setItem: (k, v) => {
        ls.set(k, v);
      },
      removeItem: (k) => {
        ls.delete(k);
      }
    },
    sessionStorage: null
  });

  writePendingLoopCommit({
    flow: "reverse-htlc",
    hashLock: ORDER_ID,
    userEvmAddress: "0xabc",
    userCantonParty: "party::1",
    wbtcAmount: "9857",
    cbtcAmount: "0.0001",
    ...futureTimelocks()
  });

  const patched = patchPendingLoopCommit({
    flow: "reverse-htlc",
    submitUpdateId: "update-1"
  });
  assert.equal(
    patched?.flow === "reverse-htlc" ? patched.submitUpdateId : undefined,
    "update-1"
  );
  assert.equal(readPendingLoopCommitByKey(ORDER_ID)?.flow === "reverse-htlc" &&
    (readPendingLoopCommitByKey(ORDER_ID) as { submitUpdateId?: string })
      .submitUpdateId,
    "update-1"
  );

  clearPendingLoopCommit();
  __setPendingLoopCommitStorageForTests({});
});
