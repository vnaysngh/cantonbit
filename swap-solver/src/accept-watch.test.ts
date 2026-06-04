/**
 * Unit tests for the accept-watch resolution logic (Task 7b), with a mock
 * CantonClient. Covers every branch: accepted, expired, accepted-too-late,
 * unknown-past-deadline, unknown-still-pending, plus record-time conversion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Hex } from "viem";

import { OrderStore, type SerializedOrder } from "./store.js";
import { resolveDelivery, recordTimeToUnixSeconds, type AcceptWatchParams } from "./accept-watch.js";
import type { CantonClient, OfferResolution } from "./canton.js";

const PARTY = "cbtc-user-abc::1220def";
const NOW = 1_780_000_000;
const FILL_DEADLINE = NOW + 3600;

function tmpStore(): OrderStore {
  return new OrderStore(`/tmp/oranj-aw-test-${Math.random().toString(36).slice(2)}.json`);
}

function order(): SerializedOrder {
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1",
    originChainId: "84532",
    expires: FILL_DEADLINE + 1000,
    fillDeadline: FILL_DEADLINE,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["1", "1"]],
    outputs: [
      {
        oracle: pad("0xaa", { size: 32 }),
        settler: pad("0xbb", { size: 32 }),
        chainId: "1000000000000002",
        token: pad("0xc87c", { size: 32 }),
        amount: "100000000",
        recipient: pad("0xrr", { size: 32 }),
        callbackData: "0x",
        context: "0x",
      },
    ],
  };
}

function mockCanton(resolution: OfferResolution, stillActive = true): CantonClient {
  return {
    resolveOffer: async () => resolution,
    isOfferActive: async () => stillActive,
  } as unknown as CantonClient;
}

function seedDelivering(store: OrderStore): Hex {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 1, order());
  store.update(id, { status: "delivering", cantonDeliveryRef: "offer1", cantonParty: PARTY });
  return id;
}

const params: AcceptWatchParams = { now: NOW, fromOffset: 0 };

test("recordTimeToUnixSeconds parses ISO", () => {
  assert.equal(recordTimeToUnixSeconds("2026-06-08T00:00:00Z"), Math.floor(Date.parse("2026-06-08T00:00:00Z") / 1000));
  assert.throws(() => recordTimeToUnixSeconds("not-a-date"));
});

test("accepted in time → delivered + fillTimestamp captured", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  const recordIso = new Date((FILL_DEADLINE - 100) * 1000).toISOString();
  const out = await resolveDelivery(store, mockCanton({ kind: "accepted", recordTime: recordIso, updateId: "u1" }), id, params);
  assert.equal(out.kind, "delivered");
  const rec = store.get(id)!;
  assert.equal(rec.status, "delivered");
  assert.equal(rec.fillTimestamp, FILL_DEADLINE - 100);
});

test("accepted AFTER fillDeadline → failed (cannot finalise)", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  const lateIso = new Date((FILL_DEADLINE + 50) * 1000).toISOString();
  const out = await resolveDelivery(store, mockCanton({ kind: "accepted", recordTime: lateIso, updateId: "u1" }), id, params);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /after fillDeadline/);
  assert.equal(store.get(id)!.status, "failed");
});

test("expired → failed, no attest", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  const out = await resolveDelivery(store, mockCanton({ kind: "expired", recordTime: "2026-06-08T00:00:00Z", updateId: "u2" }), id, params);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /expired/);
  assert.equal(store.get(id)!.status, "failed");
});

test("unknown + still active + before deadline → pending", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  const out = await resolveDelivery(store, mockCanton({ kind: "unknown" }, true), id, params);
  assert.equal(out.kind, "pending");
  assert.equal(store.get(id)!.status, "delivering"); // unchanged
});

test("unknown + still active + PAST deadline → failed (abandon)", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  const lateParams: AcceptWatchParams = { now: FILL_DEADLINE + 10, fromOffset: 0 };
  const out = await resolveDelivery(store, mockCanton({ kind: "unknown" }, true), id, lateParams);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /past fillDeadline/);
  assert.equal(store.get(id)!.status, "failed");
});

test("ignores orders not in 'delivering'", async () => {
  const store = tmpStore();
  const id = seedDelivering(store);
  store.update(id, { status: "delivered" });
  const out = await resolveDelivery(store, mockCanton({ kind: "accepted", recordTime: "2026-06-08T00:00:00Z", updateId: "u" }), id, params);
  assert.equal(out.kind, "pending");
});
