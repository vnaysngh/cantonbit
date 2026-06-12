import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";

import {
  __setLoopUnlockBypassForTests,
  __setVaultStorageForTests,
  deriveLoopVaultKey,
  deriveManagedVaultKey,
  evmAddressMatches,
  forgetSecret,
  hasStoredSecret,
  loopVaultUnlockMessage,
  pickVaultAnchor,
  recallSecret,
  rememberSecret,
  vaultExpiryFromTimelock,
  vaultMetaFromOrder,
} from "./secret-vault";

function mockStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

type StorageLike = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };

const SWAP_ID = "0x" + "11".repeat(32);
const SECRET = "0x" + "aa".repeat(32);
const PARTY = "alice::1220deadbeef";
const EVM = "0xAbCdEf1234567890123456789012345678901234";
const USER = "user-123";
const LOOP_PUB = "loop-pub-key-test";

const baseMeta = {
  direction: "evm-to-canton" as const,
  counterMode: "managed" as const,
  userCantonParty: PARTY,
  userEvmAddress: EVM,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

afterEach(() => {
  __setVaultStorageForTests(null);
});

test("pickVaultAnchor maps counterMode to anchor", () => {
  assert.equal(pickVaultAnchor("managed"), "managed-session");
  assert.equal(pickVaultAnchor("loop"), "loop-wallet");
});

test("vaultExpiryFromTimelock adds buffer", () => {
  assert.equal(vaultExpiryFromTimelock(1000), 4600);
});

test("vaultExpiryFromTimelock uses shorter solver timelock on reverse", () => {
  assert.equal(
    vaultExpiryFromTimelock(5000, { direction: "canton-to-evm", solverTimelock: 3000 }),
    6600,
  );
});

test("loopVaultUnlockMessage is stable (no timestamp)", () => {
  assert.equal(loopVaultUnlockMessage(PARTY), loopVaultUnlockMessage(PARTY));
  assert.match(loopVaultUnlockMessage(PARTY), /Vault Unlock/);
});

test("managed rememberSecret → recallSecret survives cold context", async () => {
  __setVaultStorageForTests(mockStorage());
  const ok = await rememberSecret(SWAP_ID, SECRET, baseMeta, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
  });
  assert.equal(ok, true);
  assert.equal(hasStoredSecret(SWAP_ID), true);

  const recalled = await recallSecret(SWAP_ID, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
  });
  assert.equal(recalled, SECRET);
});

test("managed rememberSecret fails without session user id", async () => {
  __setVaultStorageForTests(mockStorage());
  const ok = await rememberSecret(SWAP_ID, SECRET, baseMeta, {
    sessionPartyId: PARTY,
  });
  assert.equal(ok, false);
  assert.equal(hasStoredSecret(SWAP_ID), false);
});

test("loop rememberSecret → recallSecret after simulated refresh (cold unlock cache)", async () => {
  __setVaultStorageForTests(mockStorage());
  let signCount = 0;
  const provider = {
    party_id: PARTY,
    public_key: LOOP_PUB,
    signMessage: async () => {
      signCount += 1;
      return "0x" + "bb".repeat(65);
    },
  };

  const meta = { ...baseMeta, counterMode: "loop" as const };
  const stored = await rememberSecret(SWAP_ID, SECRET, meta, { loopProvider: provider });
  assert.equal(stored, true);

  // Simulate browser refresh: new provider object, unlock cache empty in module —
  // recall must still work with one unlock sign + deterministic key.
  const recalled = await recallSecret(SWAP_ID, {
    loopProvider: {
      party_id: PARTY,
      public_key: LOOP_PUB,
      signMessage: async () => {
        signCount += 1;
        return "0x" + "cc".repeat(65); // different signature bytes — key must NOT depend on this
      },
    },
  });
  assert.equal(recalled, SECRET);
  assert.equal(signCount, 1); // one unlock sign on recall; store uses deterministic key only
});

test("loop recall rejects wrong public_key", async () => {
  __setVaultStorageForTests(mockStorage());
  const provider = { party_id: PARTY, public_key: LOOP_PUB, signMessage: async () => "0x" + "dd".repeat(65) };
  await rememberSecret(SWAP_ID, SECRET, { ...baseMeta, counterMode: "loop" }, { loopProvider: provider });

  __setLoopUnlockBypassForTests(true);
  try {
    const recalled = await recallSecret(SWAP_ID, {
      loopProvider: {
        party_id: PARTY,
        public_key: "other-pub-key",
        signMessage: async () => "0x" + "ee".repeat(65),
      },
    });
    assert.equal(recalled, null);
  } finally {
    __setLoopUnlockBypassForTests(false);
  }
});

test("reverse recall requires matching EVM address", async () => {
  __setVaultStorageForTests(mockStorage());
  const meta = {
    ...baseMeta,
    direction: "canton-to-evm" as const,
  };
  await rememberSecret(SWAP_ID, SECRET, meta, { sessionUserId: USER, sessionPartyId: PARTY });

  assert.equal(
    evmAddressMatches(meta, "0xabcdef1234567890123456789012345678901234"),
    true,
  );

  const wrong = await recallSecret(SWAP_ID, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
    evmAddress: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(wrong, null);

  const ok = await recallSecret(SWAP_ID, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
    evmAddress: EVM,
  });
  assert.equal(ok, SECRET);
});

test("forgetSecret removes entry", async () => {
  __setVaultStorageForTests(mockStorage());
  await rememberSecret(SWAP_ID, SECRET, baseMeta, { sessionUserId: USER, sessionPartyId: PARTY });
  forgetSecret(SWAP_ID);
  assert.equal(hasStoredSecret(SWAP_ID), false);
});

test("deriveLoopVaultKey is deterministic", async () => {
  const a = await deriveLoopVaultKey(LOOP_PUB, PARTY);
  const b = await deriveLoopVaultKey(LOOP_PUB, PARTY);
  const msg = new TextEncoder().encode("x");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, msg);
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, ct);
  assert.equal(new TextDecoder().decode(out), "x");
});

test("deriveManagedVaultKey round-trip", async () => {
  const key = await deriveManagedVaultKey("user-abc", "alice::1220dead");
  const secret = "0x" + "ab".repeat(32);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  assert.equal(new TextDecoder().decode(plain), secret);
});

test("v1 plaintext is not returned without orderMeta (no gate bypass)", async () => {
  const store = mockStorage();
  __setVaultStorageForTests(store);
  store.setItem("oranj.htlc.secrets.v1", JSON.stringify({ [SWAP_ID]: SECRET }));
  const recalled = await recallSecret(SWAP_ID, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
  });
  assert.equal(recalled, null);
  assert.equal(hasStoredSecret(SWAP_ID), true);
});

test("v1 plaintext migrates to v3 when orderMeta provided", async () => {
  const store = mockStorage();
  __setVaultStorageForTests(store);
  store.setItem("oranj.htlc.secrets.v1", JSON.stringify({ [SWAP_ID]: SECRET }));
  const recalled = await recallSecret(SWAP_ID, {
    sessionUserId: USER,
    sessionPartyId: PARTY,
    orderMeta: baseMeta,
  });
  assert.equal(recalled, SECRET);
  const legacy = JSON.parse(store.getItem("oranj.htlc.secrets.v1") ?? "{}") as Record<string, string>;
  assert.equal(legacy[SWAP_ID], undefined);
});

test("vaultMetaFromOrder rejects incomplete rows", () => {
  assert.equal(vaultMetaFromOrder({ direction: "evm-to-canton", counterMode: "managed" }), null);
  assert.equal(
    vaultMetaFromOrder({
      direction: "evm-to-canton",
      counterMode: "managed",
      userCantonParty: PARTY,
      userEvmAddress: EVM,
      userTimelock: 1000,
    })?.expiresAt,
    4600,
  );
});
