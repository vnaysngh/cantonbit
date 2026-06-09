/**
 * Unit tests for the pre-openFor intake GATES (CoW order_validation.rs parity).
 *
 * These cover the PURE gates (token identity, banned user, overflow) via the
 * extracted validateOrderIntake(). The chain-dependent gates — ECDSA signature
 * recovery (D) and balance/allowance (E) — are verified live against a running
 * solver (see the session log), since they need recover + eth_call. Here we also
 * round-trip a REAL signature through viem to prove the recovery direction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pad, getAddress, recoverTypedDataAddress,
  type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { validateOrderIntake, ApiError } from "./api.js";
import { buildOpenForTypedData } from "./open-for.js";

const WBTC: Address = getAddress("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f");
const CBTC_TOKEN: Hex = pad("0xc87c", { size: 32 });
const USER: Address = "0x1111111111111111111111111111111111111111";

/** A valid order's (input, output) shapes for the pure validator. */
function goodOrder(amount = 10_000n) {
  return {
    order: { user: USER as string, inputs: [[BigInt(WBTC), amount]] as const },
    out0: { token: CBTC_TOKEN as string, amount: amount.toString() },
  };
}
const cfg = { wbtc: WBTC as string, cbtcToken: CBTC_TOKEN as string };

function expectApiError(fn: () => unknown, status: number, match: RegExp) {
  try {
    fn();
    assert.fail("expected ApiError, but no error was thrown");
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
    assert.equal(e.status, status, `status should be ${status}, got ${e.status}`);
    assert.match(e.message, match);
  }
}

// ---------- GATE A: token identity ----------

test("GATE A: a valid WBTC→cBTC order passes and returns the WBTC amount", () => {
  const { order, out0 } = goodOrder(12_345n);
  const amt = validateOrderIntake(order, out0, cfg);
  assert.equal(amt, 12_345n);
});

test("GATE A: wrong INPUT token is rejected (not the configured WBTC)", () => {
  const { order, out0 } = goodOrder();
  const bad = { ...order, inputs: [[999n, 10_000n]] as const }; // bogus token
  expectApiError(() => validateOrderIntake(bad, out0, cfg), 400, /input token is not the configured WBTC/);
});

test("GATE A: wrong OUTPUT token is rejected (not the configured cBTC)", () => {
  const { order, out0 } = goodOrder();
  const bad = { ...out0, token: pad("0xdead", { size: 32 }) as string };
  expectApiError(() => validateOrderIntake(order, bad, cfg), 400, /output token is not the configured cBTC/);
});

test("GATE A: WBTC match is case-insensitive (checksum vs lowercase)", () => {
  const { order, out0 } = goodOrder();
  // configure with a lowercased WBTC; order encodes the checksummed one → still matches.
  const amt = validateOrderIntake(order, out0, { ...cfg, wbtc: WBTC.toLowerCase() });
  assert.equal(amt, 10_000n);
});

// ---------- GATE B: banned user ----------

test("GATE B: a banned user is rejected (403)", () => {
  const { order, out0 } = goodOrder();
  const banned = new Set([USER.toLowerCase()]);
  expectApiError(() => validateOrderIntake(order, out0, { ...cfg, bannedUsers: banned }), 403, /not permitted/);
});

test("GATE B: banned check is case-insensitive", () => {
  const { order, out0 } = goodOrder();
  // user is lowercase in the order; ban list has the same lowercased → match.
  const banned = new Set([USER.toLowerCase()]);
  const upper = { ...order, user: USER.toUpperCase().replace("0X", "0x") };
  expectApiError(() => validateOrderIntake(upper, out0, { ...cfg, bannedUsers: banned }), 403, /not permitted/);
});

test("GATE B: a non-banned user passes even when a ban list exists", () => {
  const { order, out0 } = goodOrder();
  const banned = new Set(["0x9999999999999999999999999999999999999999"]);
  assert.doesNotThrow(() => validateOrderIntake(order, out0, { ...cfg, bannedUsers: banned }));
});

// ---------- GATE C: uint256 overflow / range ----------

test("GATE C: zero input amount is rejected", () => {
  const { order, out0 } = goodOrder();
  const bad = { ...order, inputs: [[BigInt(WBTC), 0n]] as const };
  expectApiError(() => validateOrderIntake(bad, out0, cfg), 400, /amount out of range/);
});

test("GATE C: input amount at/over uint256 is rejected (would truncate on-chain)", () => {
  const { order, out0 } = goodOrder();
  const bad = { ...order, inputs: [[BigInt(WBTC), 2n ** 256n]] as const };
  expectApiError(() => validateOrderIntake(bad, out0, cfg), 400, /amount out of range/);
});

test("GATE C: output amount at/over uint256 is rejected", () => {
  const { order, out0 } = goodOrder();
  const bad = { ...out0, amount: (2n ** 256n).toString() };
  expectApiError(() => validateOrderIntake(order, bad, cfg), 400, /amount out of range/);
});

test("GATE C: the largest legal amount (uint256 - 1) passes", () => {
  const max = 2n ** 256n - 1n;
  const order = { user: USER as string, inputs: [[BigInt(WBTC), max]] as const };
  const out0 = { token: CBTC_TOKEN as string, amount: max.toString() };
  assert.equal(validateOrderIntake(order, out0, cfg), max);
});

// ---------- GATE D: signature recovery DIRECTION (real round-trip) ----------
// Proves that the typed data we build recovers back to the signer — i.e. the
// gate's `recovered === order.user` comparison is correct. This is the exact
// recover the handler does (it just adds the user-equality assertion + error map).

test("GATE D: a REAL signature over our typed data recovers to the signer", async () => {
  // deterministic test key (NOT a real account)
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const order = {
    user: account.address,
    nonce: 1n, originChainId: 42161n, expires: 2_000, fillDeadline: 1_000,
    inputOracle: "0x00000000000000000000000000000000000000aa" as Address,
    inputs: [[BigInt(WBTC), 10_000n]] as const,
    outputs: [{
      oracle: pad("0xaa", { size: 32 }), settler: pad("0xbb", { size: 32 }),
      chainId: 1n, token: CBTC_TOKEN, amount: 10_000n,
      recipient: pad("0x11", { size: 32 }),
      callbackData: "0x" as Hex, context: "0x" as Hex,
    }],
  };
  const escrow = getAddress("0x306007585469a2DdE4CA8aB47D2D6A76833815e0");
  const typed = buildOpenForTypedData({ order, escrow, chainId: 42161 });
  const sig = await account.signTypedData({
    domain: typed.domain, types: typed.types,
    primaryType: typed.primaryType, message: typed.message,
  });
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain, types: typed.types,
    primaryType: typed.primaryType, message: typed.message, signature: sig,
  });
  assert.equal(getAddress(recovered), getAddress(account.address), "the gate's recover must return the true signer");
  assert.notEqual(getAddress(recovered), getAddress(USER), "a DIFFERENT user would not match → gate would reject");
});
