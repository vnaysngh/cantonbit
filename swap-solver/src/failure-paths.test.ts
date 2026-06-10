/**
 * Failure-path tests for the matrix rows C3 (exposure caps), C4 (concurrency /
 * double-delivery), C5 (crash recovery). These prove the ACTUAL behavior — including
 * gaps — so we ship a known quantity, not an assumption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Hex } from "viem";

import { InMemoryOrderStore, type OrderStore, type SerializedOrder } from "./store.js";
import { startDelivery, type DeliveryParams } from "./delivery.js";
import { cantonPartyToRecipient } from "./order.js";
import type { CantonClient, HoldingLite } from "./canton.js";

const NOW = 1_780_000_000;
const params: DeliveryParams = { minSecondsBeforeDeadline: 600, now: NOW, cbtcDecimals: 8 };
// A real party whose keccak256 we commit to as the order recipient, so
// verifyCantonParty passes and we test the RACE/recovery logic, not the hash.
const PARTY = "rcv::1220beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";

function tmpStore(): OrderStore {
  return new InMemoryOrderStore();
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

async function seedSeen(store: OrderStore, o: SerializedOrder): Promise<Hex> {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  await store.insertSeen(id, 100, o);
  await store.update(id, { cantonParty: PARTY }); // matches recipient → verify passes
  return id;
}

/** Seed an order whose record LACKS cantonParty (the crash-between-openFor-and-
 *  store-write case), optionally with the party remembered in the recovery map. */
async function seedSeenNoParty(store: OrderStore, o: SerializedOrder, remember: boolean): Promise<Hex> {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  await store.insertSeen(id, 100, o); // NO cantonParty on the record
  if (remember) await store.rememberParty(id, PARTY); // but remembered at quote time
  return id;
}

// ---------- C4: concurrency / double-delivery race ----------

test("C4: two concurrent startDelivery on the SAME order — does the status guard prevent double-delivery?", async () => {
  const store = tmpStore();
  const holdings: HoldingLite[] = [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }];
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings, onCreate: () => { createCalls++; } });
  const id = await seedSeen(store, order("1000"));

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
  const rec = (await store.get(id))!;
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
  const id = await seedSeen(store, order("1000"));
  await store.update(id, { status: "delivering" }); // already in progress
  const out = await startDelivery(store, canton, id, params);
  assert.equal(out.kind, "skipped", "a non-seen order must be skipped");
});

// ---------- RECOVERY: cantonParty preimage durability (the real prod bug) ----------
// This is the bug that locked a real user's WBTC: POST /orders submitted openFor
// (locked the WBTC), then the process was interrupted BEFORE the store write, so
// the order had no cantonParty and could never be delivered. The fix: remember
// the party at QUOTE time; the delivery path recovers it.

test("RECOVERY: an order whose party was remembered at quote time IS delivered", async () => {
  // Crash-durability of the cantonParty preimage. The on-chain order only commits
  // keccak256(party); the preimage MUST be durable before openFor or the order is
  // undeliverable. With the Postgres store, rememberParty + the order row are one
  // atomic row (canton_party column) — so a remembered party IS on the record and
  // recoverable via recallParty. (The old file store kept a SEPARATE map; the
  // collapse is equally safe because the row is written before openFor.)
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  const id = await seedSeenNoParty(store, order("1000"), /* remember */ true);
  // Precondition: the party is durable — recallParty finds it.
  assert.equal(await store.recallParty(id), PARTY, "precondition: party was remembered (durable before openFor)");

  const out = await startDelivery(store, canton, id, params);

  assert.ok(["delivering", "delivered"].includes((out as any).kind), `must deliver, got ${(out as any).kind}`);
  assert.equal(createCalls, 1, "the cBTC offer must be created");
  assert.equal((await store.get(id))!.cantonParty, PARTY, "party present on the record for delivery");
  console.log("[RECOVERY] ✓ a remembered party is durable + delivery proceeds (Postgres: one atomic row).");
});

test("RECOVERY: an order with NO cantonParty AND none remembered is SKIPPED (not delivered blind)", async () => {
  const store = tmpStore();
  let createCalls = 0;
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }], onCreate: () => { createCalls++; } });
  const id = await seedSeenNoParty(store, order("1000"), /* remember */ false);

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
  await store.insertSeen(id, 100, order("1000")); // recipient commits to PARTY
  await store.rememberParty(id, "attacker::1220dead"); // but the map says a DIFFERENT party

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
  const id = await seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, {
    ...params,
    verifyClaimable: async () => ({ ok: false, reason: "WBTC not Deposited" }),
  });
  assert.equal(out.kind, "skipped", "must NOT deliver when WBTC isn't claimable");
  assert.equal(createCalls, 0, "must NOT create the cBTC offer when pre-flight fails");
  // order stays 'seen' (not delivering) so nothing is half-done.
  assert.equal((await store.get(id))!.status, "seen");
  console.log("[PRE-FLIGHT] ✓ delivery aborted; no cBTC sent when WBTC not guaranteed.");
});

test("PRE-FLIGHT: proceeds when WBTC IS claimable", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const id = await seedSeen(store, order("1000"));
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
  const existing = await seedSeen(store, order("1000"));
  await store.update(existing, { status: "delivering" });
  // New order worth 1000 sats; cap is 1500 → 1000 in-flight + 1000 > 1500 → skip.
  const id = await seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, { ...params, maxInflightSats: 1500n });
  assert.equal(out.kind, "skipped", "must skip when in-flight cap would be exceeded");
  console.log("[C3] ✓ in-flight cap enforced: new delivery skipped above the ceiling.");
});

test("C3b: under the cap, delivery proceeds", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 1_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const id = await seedSeen(store, order("1000"));
  const out = await startDelivery(store, canton, id, { ...params, maxInflightSats: 5000n });
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "should proceed under the cap");
});

// ---------- C5: crash recovery ----------

test("C5: after a crash, a 'seen' order with a passed fillDeadline is NOT delivered (can't fill late)", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 100_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // Order whose fillDeadline already passed (crash left it stuck past deadline).
  const id = await seedSeen(store, order("1000", NOW - 10));
  const out = await startDelivery(store, canton, id, params);
  assert.equal(out.kind, "skipped", "must not deliver an order past its fillDeadline after a crash");
  console.log("[C5] ✓ a stuck 'seen' order past fillDeadline is skipped (won't deliver late) — its WBTC refunds via the escrow timeout.");
});

test("C5b: a record round-trips through the store (insert → update → read back)", async () => {
  // CROSS-PROCESS / CROSS-RESTART persistence is now provided by Postgres (the
  // store is shared DB state, not a file), and is covered by the live DB smoke
  // test — not unit-testable with the in-memory fake. Here we just assert the
  // store's basic round-trip contract: an insert + status update is readable back.
  const store = tmpStore();
  const id = pad("0xabc", { size: 32 }) as Hex;
  await store.insertSeen(id, 100, order("1000"));
  await store.update(id, { status: "delivering", cantonDeliveryRef: "offer1" });
  const rec = await store.get(id);
  assert.equal(rec?.status, "delivering", "status update must be readable back");
  assert.equal(rec?.cantonDeliveryRef, "offer1", "metadata must round-trip");
  console.log("[C5b] ✓ record round-trips through the store (persistence now via Postgres).");
});

// ---------- C6: PER-USER fairness cap (shared-float protection) ----------
// Unlike CoW (each solver fronts its OWN capital, so no shared pool to drain),
// we deliver every user's cBTC from ONE shared float. The per-user in-flight cap
// (GUARD 3b) stops a single user tying up the whole float and starving others.
// CoW's analogue is a COUNT cap (max 10 limit orders/user, order_validation.rs:461);
// ours is a VALUE cap because the risk is float-drain, not orderbook bloat.

/** Build an order for a SPECIFIC user (the default helper hardcodes one user). */
function orderForUser(amountSats: string, user: Hex, fillDeadline = NOW + 3600): SerializedOrder {
  return { ...order(amountSats, fillDeadline), user };
}

const USER_A: Hex = "0x1111111111111111111111111111111111111111";
const USER_B: Hex = "0x2222222222222222222222222222222222222222";

test("C6: per-user cap SKIPS a user's 2nd order once their in-flight value hits the ceiling", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 10_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // User A already has one order (1000 sats) delivering.
  const a1 = await seedSeen(store, orderForUser("1000", USER_A));
  await store.update(a1, { status: "delivering" });
  // A's 2nd order (1000 sats). Cap = 1500 → A has 1000 in-flight; 1000+1000 > 1500 → SKIP.
  const a2 = await seedSeen(store, orderForUser("1000", USER_A));
  const out = await startDelivery(store, canton, a2, { ...params, perUserInflightCapSats: 1500n });
  assert.equal(out.kind, "skipped", "user A's 2nd order must skip once over their per-user cap");
  assert.match((out as any).reason, /per-user in-flight cap/, "skip reason must cite the per-user cap");
  console.log("[C6] ✓ per-user cap enforced: a single user can't exceed their in-flight ceiling.");
});

test("C6b: a DIFFERENT user is NOT starved by user A's in-flight orders (cap is per-user, not global)", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 10_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // User A is at their cap (1000 sats in flight, cap 1500 — A's next would be blocked).
  const a1 = await seedSeen(store, orderForUser("1000", USER_A));
  await store.update(a1, { status: "delivering" });
  // User B's FIRST order (1000 sats) must still proceed — B has 0 in-flight.
  const b1 = await seedSeen(store, orderForUser("1000", USER_B));
  const out = await startDelivery(store, canton, b1, { ...params, perUserInflightCapSats: 1500n });
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "user B must NOT be blocked by user A's usage");
  console.log("[C6b] ✓ cap is per-user: B is not starved by A — no false cross-user blocking.");
});

test("C6c: under their own cap, a user's 2nd order proceeds", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 10_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  const a1 = await seedSeen(store, orderForUser("1000", USER_A));
  await store.update(a1, { status: "delivering" });
  // A's 2nd order (1000); cap 5000 → 1000+1000 <= 5000 → proceeds.
  const a2 = await seedSeen(store, orderForUser("1000", USER_A));
  const out = await startDelivery(store, canton, a2, { ...params, perUserInflightCapSats: 5000n });
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "A's 2nd order proceeds while under their cap");
  console.log("[C6c] ✓ under-cap orders proceed (cap doesn't over-block).");
});

test("C6d: per-user cap counts delivering + delivered, but NOT finalised/failed/refunded", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 10_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // A has prior orders in NON-in-flight states — these must NOT count against the cap.
  const done1 = await seedSeen(store, orderForUser("100000", USER_A));   await store.update(done1, { status: "finalised" });
  const done2 = await seedSeen(store, orderForUser("100000", USER_A));   await store.update(done2, { status: "refunded" });
  const done3 = await seedSeen(store, orderForUser("100000", USER_A));   await store.update(done3, { status: "failed" });
  // Plus one genuinely in-flight order worth 1000.
  const live = await seedSeen(store, orderForUser("1000", USER_A));      await store.update(live, { status: "delivered" });
  // New 1000-sat order; cap 1500. Only the `delivered` 1000 should count → 1000+1000 > 1500 → skip.
  const a = await seedSeen(store, orderForUser("1000", USER_A));
  const out = await startDelivery(store, canton, a, { ...params, perUserInflightCapSats: 1500n });
  assert.equal(out.kind, "skipped", "only delivering/delivered count; the finalised/refunded/failed 100k each must NOT inflate the sum");
  console.log("[C6d] ✓ cap counts ONLY in-flight (delivering/delivered); settled/failed/refunded excluded.");
});

test("C6e: no per-user cap configured → unlimited (opt-in, off by default)", async () => {
  const store = tmpStore();
  const canton = mockCanton({ floatSats: 10_000_000n, holdings: [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }] });
  // A has a big in-flight order; with NO cap set, a 2nd still proceeds.
  const a1 = await seedSeen(store, orderForUser("5000", USER_A));
  await store.update(a1, { status: "delivering" });
  const a2 = await seedSeen(store, orderForUser("5000", USER_A));
  const out = await startDelivery(store, canton, a2, params); // no perUserInflightCapSats
  assert.ok(["delivering", "delivered"].includes((out as any).kind), "with no cap set, orders are unlimited");
  console.log("[C6e] ✓ cap is opt-in: unset → no per-user limit (back-compat).");
});

// ---------- C7: MULTI-USER concurrency — the shared float under simultaneous load ----------
// Drives MANY users' orders through delivery at once and asserts: total cBTC
// delivered never exceeds the float (no over-delivery), and the sequential loop
// keeps the float race unreachable. This is the empirical multi-user test that was
// previously only argued from code-reading.

/**
 * A float-debiting Canton mock: same shape as mockCanton, but createOffer spends
 * `amountBtc` from a shared float so a LATER order in the same loop sees the
 * reduced balance — modelling the real sequential delivery the float guard relies on.
 */
function debitingCanton(start: bigint, onSpend: (sats: bigint) => void): { canton: CantonClient; float: () => bigint } {
  let floatSats = start;
  const holdings: HoldingLite[] = [{ contractId: "h1", amount: "1", createdEventBlob: "b", locked: false }];
  const canton = {
    solverParty: "solver::1220aaa",
    getFloatSats: async () => floatSats,
    getHoldings: async () => holdings,
    createOffer: async (args: { amountBtc: string }) => {
      const spent = BigInt(Math.round(Number(args.amountBtc) * 1e8));
      floatSats -= spent;
      onSpend(spent);
      return { updateId: "u", offerContractId: "o", autoAccepted: false, inputHoldingCids: ["h1"] };
    },
  } as unknown as CantonClient;
  return { canton, float: () => floatSats };
}

test("C7: many users delivering concurrently never over-deliver the shared float", async () => {
  const store = tmpStore();
  // Float = 5000 sats. Ten users each want 1000 sats = 10000 wanted, but only 5000 exists.
  // The float guard must let AT MOST 5 succeed; the rest fail 'insufficient float'.
  // Crucially: total delivered must NEVER exceed 5000 (no over-delivery).
  let delivered = 0n;
  const { canton, float } = debitingCanton(5000n, (s) => { delivered += s; });

  // 10 distinct users, one 1000-sat order each.
  const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => {
    const user = `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex;
    return seedSeen(store, orderForUser("1000", user));
  }));

  // Deliver them SEQUENTIALLY (this mirrors deliverSeenOrders' for...await loop —
  // the property that makes the float race unreachable). Each reads the float fresh.
  let succeeded = 0, failedFloat = 0;
  for (const id of ids) {
    const out = await startDelivery(store, canton, id, params);
    if (["delivering", "delivered"].includes((out as any).kind)) succeeded++;
    else if (/insufficient cBTC float/.test((out as any).reason ?? "")) failedFloat++;
  }

  console.log(`[C7] ${succeeded} delivered, ${failedFloat} rejected (insufficient float); total delivered=${delivered} sats, float started=5000`);
  assert.ok(delivered <= 5000n, `NEVER over-deliver the float: delivered ${delivered} > 5000`);
  assert.equal(succeeded, 5, "exactly 5 orders fit in a 5000-sat float at 1000 each");
  assert.equal(failedFloat, 5, "the other 5 must be cleanly rejected, not over-delivered");
  assert.ok(float() >= 0n, `float must never go negative (got ${float()})`);
  console.log("[C7] ✓ multi-user: shared float never over-delivered; surplus orders rejected cleanly.");
});

test("C7b: per-user cap + multi-user — one greedy user can't starve the float; others still served", async () => {
  const store = tmpStore();
  const { canton } = debitingCanton(10_000n, () => {});

  // Greedy user A submits 5 orders of 1000 each (would take 5000); per-user cap = 2000.
  const aIds = await Promise.all(Array.from({ length: 5 }, () => seedSeen(store, orderForUser("1000", USER_A))));
  // Honest user B submits 1 order of 1000.
  const bId = await seedSeen(store, orderForUser("1000", USER_B));

  const capParams = { ...params, perUserInflightCapSats: 2000n };
  let aSucceeded = 0;
  for (const id of aIds) {
    const out = await startDelivery(store, canton, id, capParams);
    if (["delivering", "delivered"].includes((out as any).kind)) aSucceeded++;
  }
  const bOut = await startDelivery(store, canton, bId, capParams);

  console.log(`[C7b] greedy user A got ${aSucceeded}/5 (cap 2000=2 orders); honest user B served: ${(bOut as any).kind}`);
  assert.equal(aSucceeded, 2, "greedy user A is capped at 2 in-flight (2000 sats), not all 5");
  assert.ok(["delivering", "delivered"].includes((bOut as any).kind), "honest user B is STILL served — not starved by A");
  console.log("[C7b] ✓ per-user cap protects the float: greedy user throttled, honest user served.");
});
