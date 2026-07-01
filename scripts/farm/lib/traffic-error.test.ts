import assert from "node:assert/strict";
import test from "node:test";

import { isTrafficError, parseTrafficError } from "./traffic-error";

// Real error shape observed on mainnet (warpx-mainnet-1), 2026-07-01 run.
const NOT_ENOUGH_CREDIT =
  'traffic rejection: {"code":"SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT","cause":"SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,0): AboveTrafficLimit(\\n  member = PAR::warpx-mainnet-1::1220517bfd86...,\\n  trafficCost = 8849,\\n  trafficState = TrafficState(extraTrafficLimit = 0, extraTrafficConsumed = 0, baseTrafficRemainder = 1545, lastConsumedCost = 5204, timestamp = 2026-06-29T19:51:56Z, availableTraffic = 1545)\\n)"}';

const REQUEST_FAILED =
  'traffic rejection: {"code":"SEQUENCER_REQUEST_FAILED","cause":"Failed to send command","sendError":"RequestRefused(SendAsyncErrorGrpc(...))"}';

test("isTrafficError matches NOT_ENOUGH_TRAFFIC_CREDIT", () => {
  assert.equal(isTrafficError(new Error(NOT_ENOUGH_CREDIT)), true);
});

test("isTrafficError matches SEQUENCER_REQUEST_FAILED / RequestRefused", () => {
  assert.equal(isTrafficError(new Error(REQUEST_FAILED)), true);
});

test("isTrafficError does NOT match a generic network error", () => {
  assert.equal(isTrafficError(new Error("fetch failed: ECONNRESET")), false);
  assert.equal(isTrafficError(new Error("insufficient CBTC")), false);
});

test("parseTrafficError extracts trafficCost and baseTrafficRemainder", () => {
  const p = parseTrafficError(new Error(NOT_ENOUGH_CREDIT));
  assert.equal(p.trafficCost, 8849);
  assert.equal(p.baseTrafficRemainder, 1545);
  assert.equal(p.availableTraffic, 1545);
});

test("parseTrafficError returns nulls when fields absent", () => {
  const p = parseTrafficError(new Error(REQUEST_FAILED));
  assert.equal(p.trafficCost, null);
  assert.equal(p.baseTrafficRemainder, null);
});
