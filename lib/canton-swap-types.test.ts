import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCantonSwapMvpPair,
  loopFillActAsParties,
  userLegReceiverParty
} from "./canton-swap-types";
import type { CantonSwapOrder } from "./canton-swap-types";

test("isCantonSwapMvpPair accepts CBTC↔CC", () => {
  assert.equal(isCantonSwapMvpPair("CBTC", "CC"), true);
  assert.equal(isCantonSwapMvpPair("CC", "CBTC"), true);
});

test("isCantonSwapMvpPair rejects same asset and non-MVP assets", () => {
  assert.equal(isCantonSwapMvpPair("CBTC", "CBTC"), false);
  assert.equal(isCantonSwapMvpPair("CBTC", "USDCX"), false);
});

const baseOrder = {
  id: "swap-1",
  status: "open" as const,
  fromAsset: "CBTC" as const,
  toAsset: "CC" as const,
  inAmount: "0.001",
  outAmount: "10",
  minOut: "10",
  quoteExpiresAt: 0,
  userParty: "user::1",
  solverParty: "solver::1",
  walletMode: "loop" as const,
  createdAt: 0
};

test("userLegReceiverParty prefers settlementParty", () => {
  const o: CantonSwapOrder = {
    ...baseOrder,
    settlementParty: "settle::1"
  };
  assert.equal(userLegReceiverParty(o), "settle::1");
});

test("userLegReceiverParty falls back to solverParty", () => {
  assert.equal(userLegReceiverParty(baseOrder), "solver::1");
});

test("loopFillActAsParties includes settlement and solver when distinct", () => {
  const o: CantonSwapOrder = {
    ...baseOrder,
    settlementParty: "settle::1"
  };
  assert.deepEqual(loopFillActAsParties(o), ["settle::1", "solver::1"]);
});

test("loopFillActAsParties uses solver only when same party", () => {
  assert.deepEqual(loopFillActAsParties(baseOrder), ["solver::1"]);
});
