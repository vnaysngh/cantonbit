import assert from "node:assert/strict";
import test from "node:test";

import { generateSecret, verifySecret } from "./htlc-client";
import {
  ensureHtlcSecretVaulted,
  resolveHtlcClaimSecret
} from "./htlc-secret-resolver";
import {
  __setVaultStorageForTests,
  forgetSecret,
  recallSecret
} from "./secret-vault";

const KNOWN_HASH =
  "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903";

function mockStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    }
  };
}

test("ensureHtlcSecretVaulted persists and verifies readback", async () => {
  __setVaultStorageForTests(mockStorage());
  const fixed = new TextEncoder().encode("the-cross-chain-secret-32bytes!!");
  const { secret, hashLock } = generateSecret(() => fixed);
  assert.equal(hashLock.toLowerCase(), KNOWN_HASH.toLowerCase());

  const userTimelock = Math.floor(Date.now() / 1000) + 7200;
  await ensureHtlcSecretVaulted(
    hashLock,
    secret,
    {
      direction: "canton-to-evm",
      counterMode: "managed",
      userCantonParty: "party::1",
      userEvmAddress: "0xabc",
      userTimelock,
      solverTimelock: userTimelock + 3600
    },
    {
      sessionUserId: "user-1",
      sessionPartyId: "party::1",
      evmAddress: "0xabc"
    }
  );

  const recalled = await recallSecret(hashLock, {
    sessionUserId: "user-1",
    sessionPartyId: "party::1",
    evmAddress: "0xabc",
    orderMeta: {
      direction: "canton-to-evm",
      counterMode: "managed",
      userCantonParty: "party::1",
      userEvmAddress: "0xabc",
      expiresAt: userTimelock + 3600
    }
  });
  assert.equal(recalled, secret);

  forgetSecret(hashLock);
  __setVaultStorageForTests(null);
});

test("resolveHtlcClaimSecret validates manual paste against hashLock", async () => {
  const fixed = new TextEncoder().encode("the-cross-chain-secret-32bytes!!");
  const { secret, hashLock } = generateSecret(() => fixed);

  const ok = await resolveHtlcClaimSecret(hashLock, hashLock, {
    manualSecret: secret,
    ctx: { sessionUserId: "user-1", sessionPartyId: "party::1" }
  });
  assert.equal(ok, secret);
  assert.equal(verifySecret(secret, hashLock), true);

  const bad = await resolveHtlcClaimSecret(hashLock, hashLock, {
    manualSecret: "0x" + "11".repeat(32),
    ctx: { sessionUserId: "user-1", sessionPartyId: "party::1" }
  });
  assert.equal(bad, null);
});
