/**
 * De-peg guard decision logic: deviation threshold, staleness, fail-closed.
 * We stub the viem public client so the test is deterministic (no live RPC).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DepegGuard } from "./depeg.js";

const NOW = 1_800_000_000;
const FEED = "0x0017abAc5b6f291F9164e35B1234CA1D697f9CF4" as const;

/** Build a guard whose readContract returns the given (answer, updatedAt). */
function guardReturning(
  answer: bigint | null,
  updatedAt: number,
  decimals = 8,
  maxDeviationBps = 100,
  maxStalenessSeconds = 3600,
): DepegGuard {
  const g = new DepegGuard({ rpcUrl: "http://x", feed: FEED, maxDeviationBps, maxStalenessSeconds });
  // Stub the private viem client.
  (g as unknown as { pub: { readContract: (a: { functionName: string }) => Promise<unknown> } }).pub = {
    readContract: async ({ functionName }) => {
      if (answer === null) throw new Error("RPC down");
      if (functionName === "decimals") return decimals;
      // latestRoundData: [roundId, answer, startedAt, updatedAt, answeredInRound]
      return [1n, answer, BigInt(updatedAt), BigInt(updatedAt), 1n];
    },
  };
  return g;
}

test("DEPEG: perfect peg (1.0) → ok", async () => {
  const g = guardReturning(100_000_000n, NOW - 60); // 1.00000000 BTC, fresh
  const r = await g.check(NOW);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.deviationBps, 0);
});

test("DEPEG: small deviation within threshold (0.9978 ≈ 22bps, max 100) → ok", async () => {
  const g = guardReturning(99_780_000n, NOW - 60); // real-ish WBTC reading
  const r = await g.check(NOW);
  assert.equal(r.ok, true, r.ok ? "" : (r as { reason: string }).reason);
});

test("DEPEG: de-peg beyond threshold (0.95 = 500bps, max 100) → PAUSED", async () => {
  const g = guardReturning(95_000_000n, NOW - 60);
  const r = await g.check(NOW);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /de-pegged/);
    assert.equal(r.deviationBps, 500);
  }
});

test("DEPEG: de-peg UP also paused (1.05 = 500bps) — symmetric", async () => {
  const g = guardReturning(105_000_000n, NOW - 60);
  const r = await g.check(NOW);
  assert.equal(r.ok, false);
});

test("DEPEG: stale feed → PAUSED even if price looks pegged", async () => {
  const g = guardReturning(100_000_000n, NOW - 7200); // 2h old, max 1h
  const r = await g.check(NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /stale/);
});

test("DEPEG: feed unreadable → FAIL-CLOSED (paused)", async () => {
  const g = guardReturning(null, NOW);
  const r = await g.check(NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unreadable|fail-closed/);
});

test("DEPEG: non-positive price → PAUSED", async () => {
  const g = guardReturning(0n, NOW - 60);
  const r = await g.check(NOW);
  assert.equal(r.ok, false);
});
