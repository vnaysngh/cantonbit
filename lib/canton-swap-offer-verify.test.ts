import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findUserLegOfferForOrder,
  validateUserLegOfferSnapshot
} from "./canton-swap-offer-verify";
import { NETWORK } from "./constants";

const order = {
  fromAsset: "CBTC" as const,
  inAmount: "0.001",
  userParty: "user::1",
  solverParty: "solver::1"
};

const baseOffer = {
  contractId: "offer-1",
  sender: "user::1",
  receiver: "solver::1",
  amountBtc: "0.00100000",
  executeBefore: new Date(Date.now() + 60_000).toISOString()
};

test("accepts matching CBTC instrument", () => {
  validateUserLegOfferSnapshot(
    {
      ...baseOffer,
      instrumentId: NETWORK.instrumentId
    },
    order,
    NETWORK.instrumentId
  );
});

test("findUserLegOfferForOrder: exact amount match", () => {
  const cid = findUserLegOfferForOrder(
    [{ ...baseOffer, amountBtc: "0.00100000" }],
    order,
    NETWORK.instrumentId
  );
  assert.equal(cid, "offer-1");
});

test("findUserLegOfferForOrder: rejects over-funded amount", () => {
  const cid = findUserLegOfferForOrder(
    [{ ...baseOffer, amountBtc: "0.00200000" }],
    order,
    NETWORK.instrumentId
  );
  assert.equal(cid, null);
});

test("findUserLegOfferForOrder: rejects under-funded amount", () => {
  const cid = findUserLegOfferForOrder(
    [{ ...baseOffer, amountBtc: "0.0009" }],
    order,
    NETWORK.instrumentId
  );
  assert.equal(cid, null);
});

test("rejects CC offer on CBTC sell order", () => {
  assert.throws(
    () =>
      validateUserLegOfferSnapshot(
        {
          ...baseOffer,
          instrumentId: { admin: "DSO::1", id: "Amulet" }
        },
        order,
        NETWORK.instrumentId
      ),
    /does not match/
  );
});

test("findUserLegOfferForOrder: matches settlement receiver party", () => {
  const cid = findUserLegOfferForOrder(
    [{ ...baseOffer, receiver: "settle::1" }],
    { ...order, settlementParty: "settle::1" },
    NETWORK.instrumentId
  );
  assert.equal(cid, "offer-1");
});

test("findUserLegOfferForOrder: rejects offer on solver when settlement party configured", () => {
  const cid = findUserLegOfferForOrder(
    [baseOffer],
    { ...order, settlementParty: "settle::1" },
    NETWORK.instrumentId
  );
  assert.equal(cid, null);
});

test("allows missing instrument when other fields match", () => {
  validateUserLegOfferSnapshot({ ...baseOffer }, order, NETWORK.instrumentId);
});
