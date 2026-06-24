import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import {
  SWAP_FLOW_MATRIX,
  c2cVisibleCompleted,
  htlcCanExposePreimageToSolver,
  htlcFlowKey,
  htlcVisibleCompleted
} from "./swap-product-invariants";

const baseHtlc: SwapOrder = {
  id: "0x" + "11".repeat(32),
  direction: "evm-to-canton",
  status: "counter_claimed",
  hashLock: ("0x" + "22".repeat(32)) as `0x${string}`,
  userTimelock: 1000,
  userCantonParty: "user::1",
  solverCantonParty: "solver::1",
  solverTimelock: 900,
  createdAt: 900,
  counterMode: "loop",
  revealedPreimage: ("0x" + "33".repeat(32)) as `0x${string}`
};

const baseC2c: CantonSwapOrder = {
  id: "order-1",
  status: "filled",
  fromAsset: "CBTC",
  toAsset: "CC",
  inAmount: "0.0001",
  outAmount: "40",
  minOut: "40",
  quoteExpiresAt: 1000,
  userParty: "user::1",
  solverParty: "solver::1",
  walletMode: "loop",
  createdAt: 900
};

test("flow matrix covers all six product flows", () => {
  assert.deepEqual(
    SWAP_FLOW_MATRIX.map((x) => x.key).sort(),
    [
      "c2c-loop",
      "c2c-managed",
      "htlc-forward-loop",
      "htlc-forward-managed",
      "htlc-reverse-loop",
      "htlc-reverse-managed"
    ]
  );
});

test("htlcFlowKey distinguishes managed and Loop atomicity modes", () => {
  assert.equal(
    htlcFlowKey({ direction: "evm-to-canton", counterMode: "managed" }),
    "htlc-forward-managed"
  );
  assert.equal(
    htlcFlowKey({ direction: "evm-to-canton", counterMode: "loop" }),
    "htlc-forward-loop"
  );
  assert.equal(
    htlcFlowKey({ direction: "canton-to-evm", counterMode: "managed" }),
    "htlc-reverse-managed"
  );
  assert.equal(
    htlcFlowKey({ direction: "canton-to-evm", counterMode: "loop" }),
    "htlc-reverse-loop"
  );
});

test("Loop forward does not expose preimage until direct delivery or exact accept is proven", () => {
  assert.equal(htlcCanExposePreimageToSolver(baseHtlc).ok, false);

  assert.equal(
    htlcCanExposePreimageToSolver({
      ...baseHtlc,
      counterTransferUpdateId: "update-delivery",
      counterClaimUpdateId: "update-accept-or-direct-proof"
    }).ok,
    true
  );
});

test("Loop forward is not user-visible complete without delivery proof and solver claim tx", () => {
  assert.equal(
    htlcVisibleCompleted({
      ...baseHtlc,
      status: "main_claimed",
      mainClaimTx: "0x" + "44".repeat(32)
    }),
    false
  );

  assert.equal(
    htlcVisibleCompleted({
      ...baseHtlc,
      status: "main_claimed",
      counterTransferUpdateId: "update-delivery",
      counterClaimUpdateId: "update-accept-or-direct-proof",
      mainClaimTx: "0x" + "44".repeat(32)
    }),
    true
  );
});

test("managed forward completion requires a Canton claim proof before EVM claim is usable", () => {
  const managed = {
    ...baseHtlc,
    counterMode: "managed" as const
  };
  assert.equal(htlcCanExposePreimageToSolver(managed).ok, false);
  assert.equal(
    htlcCanExposePreimageToSolver({
      ...managed,
      counterClaimUpdateId: "canton-claim-update"
    }).ok,
    true
  );
});

test("C2C filled is not complete while counter offer is pending accept", () => {
  assert.equal(
    c2cVisibleCompleted({
      ...baseC2c,
      settlementUpdateId: "settle-update",
      counterLegOfferCid: "counter-offer"
    }),
    false
  );
  assert.equal(
    c2cVisibleCompleted({
      ...baseC2c,
      settlementUpdateId: "settle-update",
      counterLegOfferCid: "counter-offer",
      counterReceiptUpdateId: "accept-update"
    }),
    true
  );
});

test("C2C direct fill is complete only with counter receipt proof", () => {
  assert.equal(
    c2cVisibleCompleted({
      ...baseC2c,
      settlementUpdateId: "settle-update"
    }),
    false
  );
  assert.equal(
    c2cVisibleCompleted({
      ...baseC2c,
      settlementUpdateId: "settle-update",
      counterReceiptUpdateId: "settle-update"
    }),
    true
  );
});
