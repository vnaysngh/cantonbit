import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Hex } from "viem";

import { OrderStore, type SerializedOrder, type OrderStatus } from "./store.js";
import { buildHealthReport, type MonitorParams } from "./monitor.js";

const NOW = 1_780_000_000;

function tmpStore(): OrderStore {
  return new OrderStore(`/tmp/oranj-mon-${Math.random().toString(36).slice(2)}.json`);
}

function order(fillDeadline: number): SerializedOrder {
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1", originChainId: "84532", expires: fillDeadline + 1000, fillDeadline,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["1", "1"]],
    outputs: [{ oracle: pad("0xaa", { size: 32 }), settler: pad("0xbb", { size: 32 }), chainId: "1", token: pad("0xc", { size: 32 }), amount: "1", recipient: pad("0xr", { size: 32 }), callbackData: "0x", context: "0x" }],
  };
}

function seed(store: OrderStore, status: OrderStatus, fillDeadline = NOW + 3600, patch: Record<string, unknown> = {}): Hex {
  const id = pad(`0x${Math.floor(Math.random() * 1e9).toString(16)}`, { size: 32 }) as Hex;
  store.insertSeen(id, 1, order(fillDeadline));
  store.update(id, { status, ...patch });
  return id;
}

const P: MonitorParams = { now: NOW, staleSeenSeconds: 30 * 60, deadlineWarnSeconds: 30 * 60 };

test("ok when everything is finalised", () => {
  const s = tmpStore();
  seed(s, "finalised", NOW + 3600, { finaliseTxHash: "0xabc", fillTimestamp: NOW });
  const r = buildHealthReport(s, P);
  assert.equal(r.status, "ok");
  assert.equal(r.atRisk.length, 0);
});

test("delivered orders show as atRisk", () => {
  const s = tmpStore();
  seed(s, "delivered", NOW + 3600, { fillTimestamp: NOW });
  const r = buildHealthReport(s, P);
  assert.equal(r.atRisk.length, 1);
});

test("delivered PAST deadline → critical", () => {
  const s = tmpStore();
  seed(s, "delivered", NOW - 10, { fillTimestamp: NOW - 100 });
  const r = buildHealthReport(s, P);
  assert.equal(r.status, "critical");
});

test("delivering near deadline → stuckDelivering + warn", () => {
  const s = tmpStore();
  seed(s, "delivering", NOW + 60); // within 30-min warn window
  const r = buildHealthReport(s, P);
  assert.equal(r.stuckDelivering.length, 1);
  assert.equal(r.status, "warn");
});

test("failed orders → warn", () => {
  const s = tmpStore();
  seed(s, "failed", NOW + 3600, { note: "insufficient float" });
  const r = buildHealthReport(s, P);
  assert.equal(r.failed.length, 1);
  assert.equal(r.status, "warn");
});

test("finalised without txHash → reconciliation gap → critical", () => {
  const s = tmpStore();
  seed(s, "finalised", NOW + 3600, { fillTimestamp: NOW }); // no finaliseTxHash
  const r = buildHealthReport(s, P);
  assert.equal(r.reconciliationGaps.length, 1);
  assert.equal(r.status, "critical");
});

test("counts reflect all statuses", () => {
  const s = tmpStore();
  seed(s, "seen");
  seed(s, "delivering");
  seed(s, "finalised", NOW + 3600, { finaliseTxHash: "0x1", fillTimestamp: NOW });
  const r = buildHealthReport(s, P);
  assert.equal(r.counts.seen, 1);
  assert.equal(r.counts.delivering, 1);
  assert.equal(r.counts.finalised, 1);
});
