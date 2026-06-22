import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isLoopFillPendingCounterAccept,
  isOrderExpired,
  resolveCreateCantonSwapOrder,
  shouldSkipLoopFill
} from "./canton-swap-order-logic";
import type {
  CantonSwapOrder,
  CantonSwapStatus
} from "./canton-swap-types";
import {
  filterHistoryOrders,
  isSwapClaimable,
  shouldPollOrderOnOrdersPage
} from "./htlc-order-logic";
import type { SwapOrder, SwapStatus } from "./htlc-types";

const HTLC_STATUSES: SwapStatus[] = [
  "open",
  "accepted",
  "main_locking",
  "main_locked",
  "counter_locking",
  "counter_locked",
  "counter_claimed",
  "main_claimed",
  "refunding",
  "refunded",
  "cancelled",
  "failed"
];

const C2C_STATUSES: CantonSwapStatus[] = [
  "open",
  "settling",
  "filling",
  "user_locked",
  "filled",
  "expired",
  "failed",
  "cancelled"
];

function baseC2c(overrides: Partial<CantonSwapOrder> = {}): CantonSwapOrder {
  return {
    id: "c2c-prop-1",
    status: "open",
    fromAsset: "CC",
    toAsset: "CBTC",
    inAmount: "1",
    outAmount: "0.001",
    minOut: "0.001",
    quoteExpiresAt: 1_100,
    userParty: "user::1",
    solverParty: "vault::1",
    settlementParty: "vault::1",
    walletMode: "loop",
    createdAt: 1_000,
    ...overrides
  };
}

function baseHtlc(overrides: Partial<SwapOrder> = {}): SwapOrder {
  return {
    id: "0x" + "11".repeat(32),
    direction: "evm-to-canton",
    status: "open",
    hashLock: ("0x" + "22".repeat(32)) as `0x${string}`,
    userEvmAddress: "0x" + "33".repeat(20),
    solverEvmAddress: "0x" + "44".repeat(20),
    wbtcAmount: "0.001",
    userTimelock: 10_000,
    userCantonParty: "user::1",
    solverCantonParty: "vault::1",
    cbtcAmount: "0.001",
    solverTimelock: 9_000,
    createdAt: 1_000,
    counterMode: "managed",
    ...overrides
  };
}

test("HTLC invariant: revealed orders are never user-claimable", () => {
  for (const status of HTLC_STATUSES) {
    for (const direction of ["evm-to-canton", "canton-to-evm"] as const) {
      for (const counterMode of ["managed", "loop"] as const) {
        assert.equal(
          isSwapClaimable({
            status,
            direction,
            counterMode,
            revealedPreimage: ("0x" + "aa".repeat(32)) as `0x${string}`
          }),
          false,
          `${direction}/${counterMode}/${status} should not be claimable after reveal`
        );
      }
    }
  }
});

test("HTLC invariant: unrevealed claimability is restricted to claim-safe states", () => {
  for (const status of HTLC_STATUSES) {
    assert.equal(
      isSwapClaimable({
        status,
        direction: "evm-to-canton",
        counterMode: "managed",
        revealedPreimage: undefined
      }),
      status === "counter_locked",
      `managed forward claimability mismatch at ${status}`
    );

    assert.equal(
      isSwapClaimable({
        status,
        direction: "evm-to-canton",
        counterMode: "loop",
        revealedPreimage: undefined
      }),
      status === "main_locked" || status === "counter_locked",
      `Loop forward claimability mismatch at ${status}`
    );

    assert.equal(
      isSwapClaimable({
        status,
        direction: "canton-to-evm",
        counterMode: "loop",
        revealedPreimage: undefined
      }),
      status === "counter_locked",
      `reverse claimability mismatch at ${status}`
    );
  }
});

test("history/poll invariant: terminal and never-started orders do not live-poll", () => {
  for (const status of HTLC_STATUSES) {
    const order = baseHtlc({
      status,
      mainLockTx: status === "accepted" ? undefined : "0xlock"
    });
    const expected =
      !["main_claimed", "refunded", "cancelled", "failed"].includes(status) &&
      !(status === "accepted" && !order.mainLockTx);
    assert.equal(
      shouldPollOrderOnOrdersPage(order),
      expected,
      `HTLC poll mismatch at ${status}`
    );
  }

  for (const status of C2C_STATUSES) {
    assert.equal(
      shouldPollOrderOnOrdersPage({
        id: "c2c-1",
        direction: "canton-swap",
        status
      }),
      ["settling", "filling", "user_locked"].includes(status),
      `C2C poll mismatch at ${status}`
    );
  }
});

test("C2C invariant: pending counter receipt is never expired away", () => {
  const farFuture = 999_999_999;

  const loopPending = baseC2c({
    walletMode: "loop",
    status: "user_locked",
    settlementUpdateId: "settle-update-1",
    counterLegOfferCid: "counter-offer-1",
    createdAt: 1,
    quoteExpiresAt: 2
  });
  assert.equal(isLoopFillPendingCounterAccept(loopPending), true);
  assert.equal(shouldSkipLoopFill(loopPending), true);
  assert.equal(isOrderExpired(loopPending, farFuture), false);

  const managedPending = baseC2c({
    walletMode: "managed",
    status: "settling",
    settlementUpdateId: "settle-update-1",
    counterLegOfferCid: "counter-offer-1",
    createdAt: 1,
    quoteExpiresAt: 2
  });
  assert.equal(isOrderExpired(managedPending, farFuture), false);
});

test("C2C invariant: create retries never reset live status or committed evidence", () => {
  for (const status of C2C_STATUSES) {
    const existing = baseC2c({
      status,
      userLegOfferCid: "user-offer-1",
      settlementUpdateId: status === "open" ? undefined : "settlement-1",
      counterLegOfferCid: status === "user_locked" ? "counter-1" : undefined,
      floatReserved: !["open", "expired", "failed", "cancelled"].includes(status)
    });
    const { status: _status, createdAt: _createdAt, ...incoming } = existing;
    const { order, isNew } = resolveCreateCantonSwapOrder(existing, incoming, 999);
    assert.equal(isNew, false);
    assert.equal(order.status, status);
    assert.equal(order.userLegOfferCid, existing.userLegOfferCid);
    assert.equal(order.settlementUpdateId, existing.settlementUpdateId);
    assert.equal(order.counterLegOfferCid, existing.counterLegOfferCid);
  }
});

test("HTLC history invariant: smoke and accepted-without-lock drafts are hidden", () => {
  const visible = baseHtlc({
    id: "0x" + "12".repeat(32),
    status: "main_locked",
    mainLockTx: "0xlock"
  });
  const hiddenDraft = baseHtlc({
    id: "0x" + "13".repeat(32),
    status: "accepted",
    mainLockTx: undefined
  });
  const smoke = baseHtlc({
    id: "smoke-htlc-1",
    status: "main_locked",
    mainLockTx: "0xlock"
  });

  assert.deepEqual(filterHistoryOrders([visible, hiddenDraft, smoke]), [visible]);
});
