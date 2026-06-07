import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Hex } from "viem";

import { OrderStore, type SerializedOrder, type OrderStatus } from "./store.js";
import { refundExpiredOrders, type RefundDeps } from "./refund.js";

const NOW = 1_780_000_000;

function tmpStore(): OrderStore {
  return new OrderStore(`/tmp/oranj-refund-${Math.random().toString(36).slice(2)}.json`);
}

function order(expires: number): SerializedOrder {
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1", originChainId: "84532", expires, fillDeadline: expires - 600,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["1", "1"]],
    outputs: [{ oracle: pad("0xaa", { size: 32 }), settler: pad("0xbb", { size: 32 }), chainId: "1", token: pad("0xc", { size: 32 }), amount: "1", recipient: pad("0xr", { size: 32 }), callbackData: "0x", context: "0x" }],
  };
}

function seed(store: OrderStore, status: OrderStatus, expires: number): Hex {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 1, order(expires));
  store.update(id, { status });
  return id;
}

// A deps object whose chain client THROWS if touched — so any order that reaches
// the on-chain refund call fails the test loudly. We use it to prove the sweep
// only *attempts* refunds for the right candidates (expired + non-terminal).
function trapDeps(store: OrderStore): RefundDeps {
  const trap = new Proxy(
    {},
    { get() { throw new Error("chain client must not be touched in selection tests"); } },
  );
  return {
    store,
    escrow: "0x0000000000000000000000000000000000000abc",
    account: { address: "0x0000000000000000000000000000000000000def" } as never,
    wallet: trap as never,
    pub: trap as never,
  };
}

test("sweep ignores unexpired orders (no chain call)", async () => {
  const s = tmpStore();
  seed(s, "seen", NOW + 600); // expires in the future
  seed(s, "delivering", NOW + 600);
  const results = await refundExpiredOrders(trapDeps(s), NOW);
  // Filtered out by `now > expires` before any chain touch → zero candidates.
  assert.equal(results.length, 0);
});

test("sweep ignores terminal orders even if 'expired'", async () => {
  const s = tmpStore();
  seed(s, "finalised", NOW - 600);
  seed(s, "refunded", NOW - 600);
  seed(s, "failed", NOW - 600);
  const results = await refundExpiredOrders(trapDeps(s), NOW);
  assert.equal(results.length, 0);
});

test("sweep targets ONLY pre-delivery expired orders (seen/delivering)", async () => {
  const s = tmpStore();
  seed(s, "seen", NOW - 600);
  seed(s, "delivering", NOW - 600);
  // SECURITY (HIGH-1): `delivered` must NOT be a candidate — its cBTC is already
  // with the user. Seed one to prove it's excluded from the sweep.
  seed(s, "delivered", NOW - 600);
  const results = await refundExpiredOrders(trapDeps(s), NOW);
  // Only the 2 pre-delivery orders are selected; `delivered` is excluded.
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.outcome.kind, "error");
});

test("HIGH-1: an expired DELIVERED order is NEVER auto-refunded (would double-pay)", async () => {
  const s = tmpStore();
  const id = seed(s, "delivered", NOW - 600); // cBTC accepted, then expired
  const results = await refundExpiredOrders(trapDeps(s), NOW);
  // Not even selected as a candidate → no chain touch, no refund.
  assert.equal(results.length, 0, "a delivered order must not be a refund candidate");
  // And its status is untouched (still delivered, awaiting finalise/manual review).
  assert.equal(s.get(id)!.status, "delivered");
});

test("HIGH-1: a 'failed' order whose cBTC was accepted is NOT refundable", async () => {
  const { refundOrder } = await import("./refund.js");
  const s = tmpStore();
  const id = seed(s, "failed", NOW - 600);
  s.update(id, { cbtcAccepted: true }); // accepted-but-too-late case
  const rec = s.get(id)!;
  const out = await refundOrder(rec, trapDeps(s), NOW);
  assert.equal(out.kind, "error", "must refuse to refund a cbtcAccepted order");
  assert.match((out as { message: string }).message, /already accepted/);
});
