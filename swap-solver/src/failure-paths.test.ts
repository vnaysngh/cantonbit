/**
 * Failure-path tests for the matrix rows C3 (exposure caps), C4 (concurrency /
 * double-delivery), C5 (crash recovery). These prove the ACTUAL behavior — including
 * gaps — so we ship a known quantity, not an assumption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Hex } from "viem";

import { OrderStore, type SerializedOrder } from "./store.js";
import { startDelivery, type DeliveryParams } from "./delivery.js";
import { cantonPartyToRecipient } from "./order.js";
import type { CantonClient, HoldingLite } from "./canton.js";

const NOW = 1_780_000_000;
const params: DeliveryParams = { minSecondsBeforeDeadline: 600, now: NOW, cbtcDecimals: 8 };
// A real party whose keccak256 we commit to as the order recipient, so
// verifyCantonParty passes and we test the RACE/recovery logic, not the hash.
const PARTY = "rcv::1220beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";

function tmpStore(): OrderStore {
  return new OrderStore(`/tmp/oranj-fp-${Math.random().toString(36).slice(2)}.json`);
}

function order(amountSats: string, fillDeadline = NOW + 3600): SerializedOrder {
  const recipient = cantonPartyToRecipient(PARTY);
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1", originChainId: "42161", expires: fillDeadline + 1000, fillDeadline,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["1", amountSats]],
    outputs: [{ oracle: pad("0xaa", { size: 32 }), settler: pad("0xbb", { size: 32 }), chainId: "1", token: pad("0xcc", { size: 32 }), amount: amountSats, recipient, callbackData: "0x", context: "0x" }],
  };
}

// Mock that records how many times createOffer is called and with which holdings,
// so we can detect double-spends / races. Also records allocation lifecycle calls.
function mockCanton(opts: {
  floatSats: bigint;
  holdings: HoldingLite[];
  onCreate?: (n: number) => void;
  onAllocate?: () => void;
  onExecute?: () => void;
  onWithdraw?: () => void;
}): CantonClient {
  let calls = 0;
  return {
    solverParty: "solver::1220aaa",
    getFloatSats: async () => opts.floatSats,
    getHoldings: async () => opts.holdings,
    createOffer: async () => { calls++; opts.onCreate?.(calls); return { updateId: `u${calls}`, offerContractId: `offer${calls}`, autoAccepted: false, inputHoldingCids: ["h1"] }; },
    allocate: async () => { opts.onAllocate?.(); return { updateId: "alloc-u", allocationCid: "alloc-cid", lockedHoldingCids: ["h1"] }; },
    executeAllocation: async () => { opts.onExecute?.(); return { updateId: "exec-u" }; },
    withdrawAllocation: async () => { opts.onWithdraw?.(); return { updateId: "wd-u" }; },
  } as unknown as CantonClient;
}

function seedSeen(store: OrderStore, o: SerializedOrder): Hex {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 100, o);
  store.update(id, { cantonParty: PARTY }); // matches recipient → verify passes
  return id;
}

/** Seed an order whose record LACKS cantonParty (the crash-between-openFor-and-
 *  store-write case), optionally with the party remembered in the recovery map. */
function seedSeenNoParty(store: OrderStore, o: SerializedOrder, remember: boolean): Hex {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 100, o); // NO cantonParty on the record
  if (remember) store.rememberParty(id, PARTY); // but remembered at quote time
  return id;
}

// ---------- C4: concurrency / double-delivery race ----------

test("C4: two concurrent startDelivery on the SAME order — does the status guard prevent double-delivery?", async () => {
  const store = tmpStore();
  const holdings: HoldingLite[] = [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }];
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings, onCreate: () => { createCalls++; } });
  const id = seedSeen(store, order("1000"));

  // Fire two deliveries for the SAME order concurrently (simulates API + watch loop racing).
  const [a, b] = await Promise.all([
    startDelivery(store, canton, id, params).catch((e) => ({ kind: "error", reason: String(e) })),
    startDelivery(store, canton, id, params).catch((e) => ({ kind: "error", reason: String(e) })),
  ]);

  // DOCUMENT the actual behavior: both read status==='seen' before either writes,
  // so the in-memory store may allow BOTH to call createOffer. This test records
  // whether the guard holds. If createCalls===2, the guard is INSUFFICIENT under
  // true concurrency (a known gap to fix with a reservation/lock).
  console.log(`[C4] createOffer called ${createCalls}x for one order; outcomes: ${(a as any).kind}, ${(b as any).kind}`);
  const rec = store.get(id)!;
  assert.ok(["delivering", "delivered"].includes(rec.status), `final status should be delivering/delivered, got ${rec.status}`);
  // FIX VERIFICATION: the atomic claim must ensure exactly ONE createOffer for one
  // order, even under concurrent callers. createCalls > 1 = double-delivery bug.
  assert.equal(createCalls, 1, `concurrency claim must prevent double-delivery (createOffer called ${createCalls}x)`);
  // Exactly one caller should win the claim; the other is skipped.
  const kinds = [(a as any).kind, (b as any).kind].sort();
  assert.deepEqual(kinds, ["delivering", "skipped"], `one delivers, one skips; got ${kinds}`);
  console.log("[C4] ✓ FIXED: atomic claim prevented double-delivery (1 createOffer, other skipped).");
});

test("C4b: an already-delivering order is SKIPPED (no re-delivery)", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const id = seedSeen(store, order("1000"));
  store.update(id, { status: "delivering" }); // already in progress
  const out = await startDelivery(store, canton, id, params);
  assert.equal(out.kind, "skipped", "a non-seen order must be skipped");
});

// ---------- RECOVERY: cantonParty preimage durability (the real prod bug) ----------
// This is the bug that locked a real user's WBTC: POST /orders submitted openFor
// (locked the WBTC), then the process was interrupted BEFORE the store write, so
// the order had no cantonParty and could never be delivered. The fix: remember
// the party at QUOTE time; the delivery path recovers it.

test("RECOVERY: an order with NO cantonParty on record IS delivered when the party was remembered at quote time", async () => {
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  // Crash case: record lacks cantonParty, but it was remembered at quote time.
  const id = seedSeenNoParty(store, order("1000"), /* remember */ true);
  assert.equal(store.get(id)!.cantonParty, undefined, "precondition: record has no cantonParty");

  const out = await startDelivery(store, canton, id, params);

  assert.ok(["delivering", "delivered"].includes((out as any).kind), `must deliver via recovery, got ${(out as any).kind}`);
  assert.equal(createCalls, 1, "the cBTC offer must be created once the party is recovered");
  // The recovered party is written back onto the record so later ticks don't re-recover.
  assert.equal(store.get(id)!.cantonParty, PARTY, "recovered party persisted back onto the record");
  console.log("[RECOVERY] ✓ order with lost cantonParty was recovered from the quote-time map and delivered.");
});

test("RECOVERY: an order with NO cantonParty AND none remembered is SKIPPED (not delivered blind)", async () => {
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  const id = seedSeenNoParty(store, order("1000"), /* remember */ false);

  const out = await startDelivery(store, canton, id, params);

  assert.equal(out.kind, "skipped", "must NOT deliver without a party preimage from anywhere");
  assert.equal(createCalls, 0, "no cBTC offer when the party can't be recovered");
  console.log("[RECOVERY] ✓ no blind delivery when the party is truly unknown.");
});

test("RECOVERY: a POISONED recovery map (wrong party) is REJECTED by the recipient-hash check", async () => {
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 100, order("1000")); // recipient commits to PARTY
  store.rememberParty(id, "attacker::1220dead"); // but the map says a DIFFERENT party

  const out = await startDelivery(store, canton, id, params);

  assert.equal(out.kind, "failed", "a recovered party that doesn't hash to the commitment must be rejected");
  assert.equal(createCalls, 0, "no cBTC offer when the recovered party is wrong (no redirect)");
  console.log("[RECOVERY] ✓ poisoned recovery map can't redirect cBTC — recipient-hash check holds.");
});

// ---------- PRE-FLIGHT: WBTC must be claimable before delivering cBTC ----------

test("PRE-FLIGHT: aborts delivery when WBTC is NOT securely claimable", async () => {
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  const id = seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, {
    ...params,
    verifyClaimable: async () => ({ ok: false, reason: "WBTC not Deposited" }),
  });
  assert.equal(out.kind, "skipped", "must NOT deliver when WBTC isn't claimable");
  assert.equal(createCalls, 0, "must NOT create the cBTC offer when pre-flight fails");
  // order stays 'seen' (not delivering) so nothing is half-done.
  assert.equal(store.get(id)!.status, "seen");
  console.log("[PRE-FLIGHT] ✓ delivery aborted; no cBTC sent when WBTC not guaranteed.");
});

test("PRE-FLIGHT: proceeds when WBTC IS claimable", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const id = seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, {
    ...params,
    verifyClaimable: async () => ({ ok: true }),
  });
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "delivers when WBTC is claimable");
});

// ---------- C3: total in-flight exposure cap ----------

test("C3: in-flight cap skips a new delivery once the ceiling is reached", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 1_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // Seed one already-delivering order worth 1000 sats.
  const existing = seedSeen(store, order("1000"));
  store.update(existing, { status: "delivering" });
  // New order worth 1000 sats; cap is 1500 → 1000 in-flight + 1000 > 1500 → skip.
  const id = seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, { ...params, maxInflightSats: 1500n });
  assert.equal(out.kind, "skipped", "must skip when in-flight cap would be exceeded");
  console.log("[C3] ✓ in-flight cap enforced: new delivery skipped above the ceiling.");
});

test("C3b: under the cap, delivery proceeds", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 1_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const id = seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, { ...params, maxInflightSats: 5000n });
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "should proceed under the cap");
});

// ---------- C5: crash recovery ----------

test("C5: after a crash, a 'seen' order with a passed fillDeadline is NOT delivered (can't fill late)", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // Order whose fillDeadline already passed (crash left it stuck past deadline).
  const id = seedSeen(store, order("1000", NOW - 10));
  const out = await startDelivery(store, canton, id, params);
  assert.equal(out.kind, "skipped", "must not deliver an order past its fillDeadline after a crash");
  console.log("[C5] ✓ a stuck 'seen' order past fillDeadline is skipped (won't deliver late) — its WBTC refunds via the escrow timeout.");
});

test("C5b: store survives reload — in-flight status persists across a 'restart'", () => {
  const path = `/tmp/oranj-fp-reload-${Math.random().toString(36).slice(2)}.json`;
  const s1 = new OrderStore(path);
  const id = pad("0xabc", { size: 32 }) as Hex;
  s1.insertSeen(id, 100, order("1000"));
  s1.update(id, { status: "delivering", cantonDeliveryRef: "offer1" });
  // Simulate restart: new store instance from the same file.
  const s2 = new OrderStore(path);
  s2.reload();
  const rec = s2.get(id);
  assert.equal(rec?.status, "delivering", "in-flight status must survive a restart (crash-safe store)");
  console.log("[C5b] ✓ in-flight order state persists across restart (no loss of tracking).");
});
