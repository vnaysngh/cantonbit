import assert from "node:assert/strict";
import test from "node:test";

import { isAuthError, isTrafficError, parseTrafficError } from "./traffic-error";

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

test("isAuthError matches the 401 security-sensitive JWT expiry", () => {
  const e = new Error(
    'ledger-end failed (401): {"code":"NA","cause":"A security-sensitive error has been received"}'
  );
  assert.equal(isAuthError(e), true);
});

test("isAuthError does NOT match traffic or network errors", () => {
  assert.equal(isAuthError(new Error(NOT_ENOUGH_CREDIT)), false);
  assert.equal(isAuthError(new Error("fetch failed: ECONNRESET")), false);
});

// Regression: the ledger truncated traffic rejections to 300 chars, which cut off
// baseTrafficRemainder (~char 258 with a real party id, further with a JSON
// envelope). Losing it makes gatedSend reset the bucket to 0 and blind-wait a full
// ~21min refill window instead of the real few seconds. This asserts the fields
// survive at the width ledger.ts now uses.
test("parses trafficCost + baseTrafficRemainder from a full-length rejection", () => {
  const raw =
    '{"cause":"SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,0): AboveTrafficLimit(' +
    "member = PAR::warpx-mainnet-1::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99, " +
    "trafficCost = 8849, " +
    "trafficState = TrafficState(extraTrafficLimit = 0, extraTrafficConsumed = 0, " +
    "baseTrafficRemainder = 4546, lastConsumedCost = 5204, availableTraffic = 4546))\"}";
  const err = new Error(`traffic rejection: ${raw.slice(0, 2000)}`);
  assert.ok(isTrafficError(err));
  const p = parseTrafficError(err);
  assert.equal(p.trafficCost, 8849);
  assert.equal(p.baseTrafficRemainder, 4546);
  assert.equal(p.availableTraffic, 4546);
});

test("a 300-char slice would have LOST baseTrafficRemainder (the old bug)", () => {
  const raw =
    "SEQUENCER_NOT_ENOUGH_TRAFFIC_CREDIT(9,0): AboveTrafficLimit(" +
    "member = PAR::warpx-mainnet-1::1220517bfd86ef5732610705a35b7b2d56e36112550d6a2b778971dbd099a3d36e99, " +
    "trafficCost = 8849, " +
    "trafficState = TrafficState(extraTrafficLimit = 0, extraTrafficConsumed = 0, " +
    "baseTrafficRemainder = 4546, lastConsumedCost = 5204, availableTraffic = 4546))";
  const truncated = parseTrafficError(new Error(`traffic rejection: ${raw.slice(0, 300)}`));
  assert.equal(truncated.availableTraffic, null, "old width dropped availableTraffic");
  const wide = parseTrafficError(new Error(`traffic rejection: ${raw.slice(0, 2000)}`));
  assert.equal(wide.availableTraffic, 4546, "new width keeps it");
});
