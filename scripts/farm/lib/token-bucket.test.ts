import assert from "node:assert/strict";
import test from "node:test";

import { TokenBucket } from "./token-bucket";

const CFG = { burstBytes: 400_000, refillBytesPerSec: 333.3, targetUtilization: 0.9 };
// usable cap = 400000 × 0.9 = 360,000

test("starts full at the usable cap", () => {
  const b = new TokenBucket(CFG, 0);
  assert.equal(b.available(0), 360_000);
  assert.equal(b.capacity(), 360_000);
});

test("startFull=false starts empty", () => {
  const b = new TokenBucket(CFG, 0, false);
  assert.equal(b.available(0), 0);
});

test("a full bucket affords a burst with zero wait", () => {
  const b = new TokenBucket(CFG, 0);
  const cycle = 9457 * 5; // 47,285 B
  // 360000 / 47285 ≈ 7.6 → 7 cycles back-to-back, spending as we go
  let now = 0;
  let fired = 0;
  for (let i = 0; i < 7; i++) {
    assert.equal(b.waitMsFor(cycle, now), 0, `cycle ${i} should be free`);
    b.spend(cycle, now);
    now += 1; // ~instant
    fired++;
  }
  assert.equal(fired, 7);
});

test("drained bucket waits exactly the refill time for the shortfall", () => {
  const b = new TokenBucket(CFG, 0, false); // empty
  const bytes = 47_285;
  const wait = b.waitMsFor(bytes, 0);
  // empty → need all 47285 B at the effective 333.3 × 0.9 = 300 B/s.
  assert.equal(wait, Math.ceil((bytes / (333.3 * 0.9)) * 1000));
});

test("refill is clamped to the usable cap (no overflow)", () => {
  const b = new TokenBucket(CFG, 0, false);
  // after a very long idle, tokens cap at 360000, not unbounded
  assert.equal(b.available(10_000_000), 360_000);
});

test("spend then wait then afford again (sustainable steady state)", () => {
  const b = new TokenBucket(CFG, 0);
  const cycle = 47_285;
  // drain the burst
  let now = 0;
  while (b.waitMsFor(cycle, now) === 0) {
    b.spend(cycle, now);
    now += 1000;
  }
  // now it must wait; the wait should let exactly one cycle through
  const wait = b.waitMsFor(cycle, now);
  assert.ok(wait > 0, "should need to wait once drained");
  now += wait;
  assert.equal(b.waitMsFor(cycle, now), 0, "after waiting, one cycle is affordable");
});

test("cheaper transfers → shorter steady-state wait", () => {
  const cheap = new TokenBucket(CFG, 0, false);
  const dear = new TokenBucket(CFG, 0, false);
  const waitCheap = cheap.waitMsFor(5204 * 5, 0);
  const waitDear = dear.waitMsFor(9457 * 5, 0);
  assert.ok(waitCheap < waitDear, "5204B cycle waits less than 9457B cycle");
});

test("start-empty bucket makes the FIRST transfer wait ~a refill window", () => {
  const b = new TokenBucket(CFG, 0, false); // empty
  const wait = b.waitMsFor(9000, 0);
  // waitMsFor accrues at the THROTTLED effective rate (333.3 × 0.9 = 300 B/s):
  // empty → 9000 B ÷ 300 B/s = 30.0s. Utilization throttles our accrual, leaving
  // margin for co-tenant traffic on the shared bucket.
  assert.equal(wait, Math.ceil((9000 / (333.3 * 0.9)) * 1000));
  assert.ok(wait > 0, "an empty bucket must wait before the first transfer");
});

test("reset snaps tokens to the real node level and re-anchors the clock", () => {
  const b = new TokenBucket(CFG, 1000, false); // empty at t=1000ms
  b.reset(2032, 5000); // node reports 2032 B remaining at t=5000ms
  assert.equal(b.available(5000), 2032);
  // 1s after reset, accrues at the throttled effective rate (333.3 × 0.9 B/s)
  assert.equal(b.available(6000), 2032 + 333.3 * 0.9, "refills at effective rate after reset anchor");
});

test("reset clamps to the usable cap", () => {
  const b = new TokenBucket(CFG, 0, false);
  b.reset(999_999, 0); // absurd — should clamp to cap 360000
  assert.equal(b.available(0), 360_000);
});

// ── Byte-estimate convergence (mirrors pingpong.ts EWMA clamp) ───────────────
// pingpong.ts blends each observed real trafficCost into estBytes instead of
// ratcheting it up with Math.max, so one fragmented worst-case sample cannot pin
// the pacing gate high forever. These assert the arithmetic that drives that.
const MIN_BYTES = 8600;
const BURST = 400_000;
const ALPHA = 0.25;

function blend(est: number, observed: number): number {
  const b = est * (1 - ALPHA) + observed * ALPHA;
  return Math.min(BURST, Math.max(MIN_BYTES, Math.ceil(b)));
}

test("byte estimate converges DOWN toward the observed real cost", () => {
  let est = 9457; // fragmented worst-case start
  for (let i = 0; i < 25; i++) est = blend(est, 8634);
  assert.ok(est < 8700, `expected convergence toward 8634, got ${est}`);
  assert.ok(est >= MIN_BYTES, `must not fall below floor, got ${est}`);
});

test("byte estimate never drops below the floor", () => {
  let est = 9457;
  for (let i = 0; i < 100; i++) est = blend(est, 10); // absurd low samples
  assert.equal(est, MIN_BYTES);
});

test("a single worst-case sample does not pin the estimate high", () => {
  let est = 8634;
  est = blend(est, 12_000); // one bad fragmented sample
  const afterSpike = est;
  for (let i = 0; i < 10; i++) est = blend(est, 8634); // normal samples resume
  assert.ok(est < afterSpike, "estimate must recover after a spike");
});
