import { strict as assert } from "node:assert";
import { test } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3";

import { generateSecret, secretToPreimage, verifySecret } from "./htlc-client";

// EVM HTLCEscrow + Daml CbtcHtlcTest both use this 32-byte preimage and hashLock.
const KNOWN_PREIMAGE_RAW = "the-cross-chain-secret-32bytes!!";
const KNOWN_H =
  "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903";

const bytesToHex = (b: Uint8Array) =>
  "0x" +
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

test("parity: keccak256(raw secret bytes) == canonical EVM/Daml hashLock", () => {
  const raw = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  assert.equal(raw.length, 32);
  assert.equal(bytesToHex(keccak_256(raw)).toLowerCase(), KNOWN_H);
});

test("generateSecret: hashLock == keccak256(secret bytes)", () => {
  const fixed = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  const { secret, hashLock } = generateSecret(() => fixed);
  assert.equal(secret, bytesToHex(fixed));
  assert.equal(hashLock.toLowerCase(), KNOWN_H);
});

test("verifySecret accepts matching secret and rejects wrong secret", () => {
  const fixed = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  const { secret, hashLock } = generateSecret(() => fixed);
  assert.equal(verifySecret(secret, hashLock), true);
  assert.equal(
    verifySecret(
      "0x" + "11".repeat(32),
      hashLock
    ),
    false
  );
});

test("secretToPreimage: lowercase hex without 0x prefix", () => {
  const fixed = new TextEncoder().encode(KNOWN_PREIMAGE_RAW);
  const { secret } = generateSecret(() => fixed);
  assert.equal(
    secretToPreimage(secret),
    "7468652d63726f73732d636861696e2d7365637265742d333262797465732121",
  );
  assert.ok(!secretToPreimage(secret).startsWith("0x"));
});
