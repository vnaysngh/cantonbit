import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, toHex, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  generateSecret,
  secretToCantonPreimage,
  verifySecret,
  buildTimelocks,
  buildHtlcOrder,
  buildHtlcOrderTypedData,
  signHtlcOrder,
  type HtlcSwapRequest,
} from "./htlc-order.js";

// The EVM HTLCEscrow test + the Daml test both use the preimage
// "the-cross-chain-secret-32bytes!!" and produce
// H = 0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903.
// Confirm our generator's hashing matches that canonical value (T2 parity).
const KNOWN_PREIMAGE_RAW = "the-cross-chain-secret-32bytes!!"; // 32 ascii bytes
const KNOWN_H = "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903";

test("parity: keccak256(raw secret bytes) == the EVM/Daml hashLock", () => {
  const raw = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  assert.equal(raw.length, 32);
  assert.equal(keccak256(raw).toLowerCase(), KNOWN_H);
});

test("generateSecret: hashLock == keccak256(secret bytes)", () => {
  // deterministic 'random' for the test
  const fixed = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  const { secret, hashLock } = generateSecret(() => fixed);
  assert.equal(secret, toHex(fixed));
  assert.equal(hashLock.toLowerCase(), KNOWN_H);
  assert.ok(verifySecret(secret, hashLock));
});

test("secretToCantonPreimage: lowercase hex, no 0x (what the Daml claim takes)", () => {
  const fixed = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  const { secret } = generateSecret(() => fixed);
  const cantonPre = secretToCantonPreimage(secret);
  assert.equal(cantonPre, "7468652d63726f73732d636861696e2d7365637265742d333262797465732121");
  assert.ok(!cantonPre.startsWith("0x"));
});

test("verifySecret rejects a wrong secret", () => {
  const { hashLock } = generateSecret(() => new TextEncoder().encode(KNOWN_PREIMAGE_RAW));
  const wrong = toHex(new TextEncoder().encode("wrong-secret-wrong-secret-wrong!"));
  assert.equal(verifySecret(wrong, hashLock), false);
});

test("buildTimelocks: EVM (user) later than Canton (solver), min 2h", () => {
  const now = 1_000_000;
  const tl = buildTimelocks(now, 4 * 3600, 2 * 3600); // 4h window, 2h gap
  assert.equal(tl.userTimelock, now + 4 * 3600);
  assert.equal(tl.solverTimelock, now + 4 * 3600 - 2 * 3600);
  assert.ok(tl.solverTimelock < tl.userTimelock);
  // < 2h window rejected
  assert.throws(() => buildTimelocks(now, 3600, 1800));
  // bad gap rejected
  assert.throws(() => buildTimelocks(now, 4 * 3600, 0));
  assert.throws(() => buildTimelocks(now, 4 * 3600, 5 * 3600));
});

test("signHtlcOrder: signature recovers to the user, binds hashLock + timelocks", async () => {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const now = 3_000_000;
  const req: HtlcSwapRequest = {
    user: account.address,
    wbtcAmount: 20000n,
    cbtcAmount: 20009n,
    cantonParty: "user::1220abcd",
    hashLock: KNOWN_H as `0x${string}`,
    timelocks: buildTimelocks(now, 4 * 3600, 2 * 3600),
    nonce: 7n,
  };
  const chainId = 421614; // Arbitrum Sepolia
  const escrow = "0x000000000000000000000000000000000000bEEF" as const;

  const sig = await signHtlcOrder({ account, req, chainId, escrow });
  const typed = buildHtlcOrderTypedData({ req, chainId, escrow });

  const recovered = await recoverTypedDataAddress({
    ...(typed as never),
    signature: sig,
  });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());

  // tampering with the hashLock invalidates the recovered signer
  const tampered = buildHtlcOrderTypedData({
    req: { ...req, hashLock: ("0x" + "11".repeat(32)) as `0x${string}` },
    chainId,
    escrow,
  });
  const recovered2 = await recoverTypedDataAddress({ ...(tampered as never), signature: sig });
  assert.notEqual(recovered2.toLowerCase(), account.address.toLowerCase());
});

test("buildHtlcOrder: deterministic swapId, enforces timelock ladder", () => {
  const now = 2_000_000;
  const req: HtlcSwapRequest = {
    user: "0x00000000000000000000000000000000000000aa",
    wbtcAmount: 20000n,
    cbtcAmount: 20009n,
    cantonParty: "user::1220abcd",
    hashLock: KNOWN_H as `0x${string}`,
    timelocks: buildTimelocks(now, 4 * 3600, 2 * 3600),
    nonce: 1n,
  };
  const a = buildHtlcOrder(req);
  const b = buildHtlcOrder(req);
  assert.equal(a.swapId, b.swapId, "deterministic");

  // changing any committed field changes the swapId
  const a2 = buildHtlcOrder({ ...req, cbtcAmount: 20010n });
  assert.notEqual(a.swapId, a2.swapId);

  // inverted ladder rejected
  assert.throws(() =>
    buildHtlcOrder({
      ...req,
      timelocks: { userTimelock: now + 3600, solverTimelock: now + 7200 },
    }),
  );
});
