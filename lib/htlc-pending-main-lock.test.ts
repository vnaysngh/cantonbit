import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  __setPendingMainLockStorageForTests,
  forgetPendingMainLock,
  readPendingMainLocks,
  rememberPendingMainLock,
  selectPendingMainLock
} from "./htlc-pending-main-lock";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function mockStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

const SWAP_ID = `0x${"11".repeat(32)}`;
const LOCK_TX = `0x${"22".repeat(32)}`;

afterEach(() => {
  __setPendingMainLockStorageForTests(null);
});

test("pending main lock survives a new read and normalizes the EVM address", () => {
  __setPendingMainLockStorageForTests(mockStorage());
  const ok = rememberPendingMainLock({
    swapId: SWAP_ID,
    lockTx: LOCK_TX,
    userCantonParty: "alice::1220abc",
    userEvmAddress: "0xAbCd",
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  assert.equal(ok, true);
  assert.deepEqual(
    readPendingMainLocks().map((item) => ({
      swapId: item.swapId,
      lockTx: item.lockTx,
      userEvmAddress: item.userEvmAddress
    })),
    [
      {
        swapId: SWAP_ID,
        lockTx: LOCK_TX,
        userEvmAddress: "0xabcd"
      }
    ]
  );
});

test("pending main lock is removed after API acknowledgement", () => {
  __setPendingMainLockStorageForTests(mockStorage());
  rememberPendingMainLock({
    swapId: SWAP_ID,
    lockTx: LOCK_TX,
    userCantonParty: "alice::1220abc",
    userEvmAddress: "0xabcd",
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  forgetPendingMainLock(SWAP_ID);
  assert.deepEqual(readPendingMainLocks(), []);
});

test("expired and malformed pending locks fail closed", () => {
  const store = mockStorage();
  __setPendingMainLockStorageForTests(store);
  assert.equal(
    rememberPendingMainLock({
      swapId: "not-a-hash",
      lockTx: LOCK_TX,
      userCantonParty: "alice::1220abc",
      userEvmAddress: "0xabcd",
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    }),
    false
  );
  rememberPendingMainLock({
    swapId: SWAP_ID,
    lockTx: LOCK_TX,
    userCantonParty: "alice::1220abc",
    userEvmAddress: "0xabcd",
    expiresAt: Math.floor(Date.now() / 1000) - 1
  });
  assert.deepEqual(readPendingMainLocks(), []);
});

test("pending recovery selects only the originating Canton and EVM wallets", () => {
  const now = Date.now();
  const locks = [
    {
      swapId: SWAP_ID,
      lockTx: LOCK_TX,
      userCantonParty: "alice::1220abc",
      userEvmAddress: "0xabcd",
      expiresAt: Math.floor(now / 1000) + 3600,
      createdAt: now
    },
    {
      swapId: `0x${"33".repeat(32)}`,
      lockTx: `0x${"44".repeat(32)}`,
      userCantonParty: "bob::1220def",
      userEvmAddress: "0xbeef",
      expiresAt: Math.floor(now / 1000) + 3600,
      createdAt: now + 1
    }
  ];
  assert.equal(
    selectPendingMainLock(locks, {
      userCantonParty: "bob::1220def",
      userEvmAddress: "0xBEEF"
    })?.userCantonParty,
    "bob::1220def"
  );
  assert.equal(
    selectPendingMainLock(locks, {
      userCantonParty: "alice::1220abc",
      userEvmAddress: "0xbeef"
    }),
    undefined
  );
});
