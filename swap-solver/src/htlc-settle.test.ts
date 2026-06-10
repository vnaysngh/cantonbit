import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HtlcSettler } from "./htlc-settle.js";

// We can't spin up a chain here, so we test the GUARD: claimWithPreimage must
// reject a preimage that doesn't match the hashLock BEFORE touching the chain.
// (The on-chain claim path is exercised by the Foundry tests for HTLCEscrow and
// the e2e in T13.)

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const PREIMAGE = toHex(new TextEncoder().encode("the-cross-chain-secret-32bytes!!"));
const H = "0x94277b389401042e35f8709846050797955e2b321bee500555c2fbdc2f4e9903" as const;

test("claimWithPreimage rejects a mismatched preimage without hitting the chain", async () => {
  const settler = new HtlcSettler({
    rpcUrl: "http://127.0.0.1:1", // unreachable — proves we don't call it
    htlcEscrow: "0x000000000000000000000000000000000000bEEF",
    account,
  });
  const wrong = toHex(new TextEncoder().encode("wrong-secret-wrong-secret-wrong!"));
  const out = await settler.claimWithPreimage(wrong, H);
  assert.equal(out.kind, "badPreimage");
});

test("the correct preimage passes the keccak guard (would proceed to chain)", () => {
  // Pure parity check: keccak256(PREIMAGE raw bytes) == H.
  assert.equal(keccak256(PREIMAGE).toLowerCase(), H);
});
