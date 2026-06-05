/**
 * Unit tests for the delivery guard logic (Task 7a), using a mock CantonClient
 * so no live ledger is needed. Covers: status gating, time guard, party
 * preimage verification (the security-critical check), insufficient float, and
 * the happy path (offer created → status 'delivering').
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, pad, stringToHex, type Hex } from "viem";

import { OrderStore, type SerializedOrder } from "./store.js";
import { startDelivery, type DeliveryParams } from "./delivery.js";
import { InsufficientFloatError, type CantonClient, type HoldingLite } from "./canton.js";
import { rmSync } from "node:fs";

const CANTON_PARTY = "cbtc-user-abc::1220def456";
const RECIPIENT_HASH = keccak256(stringToHex(CANTON_PARTY));

function tmpStore(): OrderStore {
  const p = `/tmp/oranj-delivery-test-${Math.random().toString(36).slice(2)}.json`;
  return new OrderStore(p);
}

function sampleOrder(fillDeadline: number, recipient: Hex = RECIPIENT_HASH): SerializedOrder {
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1",
    originChainId: "84532",
    expires: fillDeadline + 1000,
    fillDeadline,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["123", "500000000"]],
    outputs: [
      {
        oracle: pad("0xaa", { size: 32 }),
        settler: pad("0xbb", { size: 32 }),
        chainId: "1000000000000002",
        token: pad("0xc87c", { size: 32 }),
        amount: "100000000", // 1 cBTC at 8dp
        recipient,
        callbackData: "0x",
        context: "0x",
      },
    ],
  };
}

/** A mock CantonClient. Only the methods delivery.ts uses are implemented. */
function mockCanton(opts: {
  floatSats: bigint;
  onCreate?: () => { updateId: string; offerContractId: string };
  createThrows?: unknown;
}): CantonClient {
  const holdings: HoldingLite[] = [
    { contractId: "h1", amount: "10", createdEventBlob: "blob", locked: false },
  ];
  return {
    solverParty: "solver::1220aaa",
    getFloatSats: async () => opts.floatSats,
    getHoldings: async () => holdings,
    createOffer: async () => {
      if (opts.createThrows) throw opts.createThrows;
      return opts.onCreate?.() ?? { updateId: "u1", offerContractId: "offer1" };
    },
  } as unknown as CantonClient;
}

const NOW = 1_780_000_000;
const params: DeliveryParams = {
  minSecondsBeforeDeadline: 600,
  now: NOW,
  cbtcDecimals: 8,
};

function seedSeen(store: OrderStore, order: SerializedOrder, cantonParty?: string): Hex {
  const orderId = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(orderId, 100, order);
  if (cantonParty !== undefined) store.update(orderId, { cantonParty });
  return orderId;
}

test("happy path: creates offer and marks delivering", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), CANTON_PARTY);
  const out = await startDelivery(store, mockCanton({ floatSats: 5_00_000_000n }), id, params);
  assert.equal(out.kind, "delivering");
  assert.equal(store.get(id)!.status, "delivering");
  assert.equal(store.get(id)!.cantonDeliveryRef, "offer1");
});

test("skips when not in 'seen' status", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), CANTON_PARTY);
  store.update(id, { status: "delivered" });
  const out = await startDelivery(store, mockCanton({ floatSats: 5_00_000_000n }), id, params);
  assert.equal(out.kind, "skipped");
});

test("skips when too close to fillDeadline", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 300), CANTON_PARTY); // 300s < 600 min
  const out = await startDelivery(store, mockCanton({ floatSats: 5_00_000_000n }), id, params);
  assert.equal(out.kind, "skipped");
  assert.equal(store.get(id)!.status, "seen"); // unchanged, will retry never (deadline) but not failed here
});

test("skips when Canton party preimage is missing", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600)); // no cantonParty
  const out = await startDelivery(store, mockCanton({ floatSats: 5_00_000_000n }), id, params);
  assert.equal(out.kind, "skipped");
});

test("FAILS when party does not match the recipient commitment", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), "cbtc-user-WRONG::1220evil");
  const out = await startDelivery(store, mockCanton({ floatSats: 5_00_000_000n }), id, params);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /does not match/);
  assert.equal(store.get(id)!.status, "failed");
});

test("FAILS on insufficient float", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), CANTON_PARTY);
  // need 1 cBTC = 1e8 sats; float is only 1000 sats
  const out = await startDelivery(store, mockCanton({ floatSats: 1000n }), id, params);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /insufficient/);
  assert.equal(store.get(id)!.status, "failed");
});

test("transient createOffer error leaves order as 'seen' for retry", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), CANTON_PARTY);
  const out = await startDelivery(
    store,
    mockCanton({ floatSats: 5_00_000_000n, createThrows: new Error("rpc timeout") }),
    id,
    params,
  );
  assert.equal(out.kind, "skipped");
  assert.equal(store.get(id)!.status, "seen");
});

test("InsufficientFloatError from createOffer marks failed", async () => {
  const store = tmpStore();
  const id = seedSeen(store, sampleOrder(NOW + 3600), CANTON_PARTY);
  const out = await startDelivery(
    store,
    mockCanton({ floatSats: 5_00_000_000n, createThrows: new InsufficientFloatError(1n, 2n) }),
    id,
    params,
  );
  assert.equal(out.kind, "failed");
  assert.equal(store.get(id)!.status, "failed");
});
