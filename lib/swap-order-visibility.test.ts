import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  c2cOrderHasUserPaymentProof,
  filterVisibleC2cHistoryOrders,
  filterVisibleHtlcHistoryOrders,
  htlcOrderHasUserPaymentProof,
  htlcOrderNeedsLoopRecovery,
  htlcOrderVisibleInHistory
} from "./swap-order-visibility";

test("htlcOrderHasUserPaymentProof requires forward mainLockTx", () => {
  assert.ok(
    htlcOrderHasUserPaymentProof({
      direction: "evm-to-canton",
      status: "accepted",
      mainLockTx: "0x" + "a".repeat(64)
    })
  );
  assert.ok(
    !htlcOrderHasUserPaymentProof({
      direction: "evm-to-canton",
      status: "accepted"
    })
  );
});

test("htlcOrderHasUserPaymentProof requires reverse custody evidence", () => {
  assert.ok(
    !htlcOrderHasUserPaymentProof({
      direction: "canton-to-evm",
      status: "main_locking"
    })
  );
  assert.ok(
    htlcOrderHasUserPaymentProof({
      direction: "canton-to-evm",
      status: "main_locked",
      counterTransferOfferCid: "cid-1"
    })
  );
});

test("c2cOrderHasUserPaymentProof hides loop open drafts", () => {
  assert.ok(
    !c2cOrderHasUserPaymentProof({
      walletMode: "loop",
      status: "open"
    })
  );
  assert.ok(
    c2cOrderHasUserPaymentProof({
      walletMode: "loop",
      status: "user_locked",
      userLegOfferCid: "cid-1"
    })
  );
});

test("htlcOrderNeedsLoopRecovery exposes reverse pre-lock rows", () => {
  assert.ok(
    htlcOrderNeedsLoopRecovery({
      direction: "canton-to-evm",
      counterMode: "loop",
      status: "main_locking",
      evmFloatReserved: true
    })
  );
  assert.ok(
    !htlcOrderNeedsLoopRecovery({
      direction: "canton-to-evm",
      counterMode: "loop",
      status: "main_locking"
    })
  );
});

test("htlcOrderVisibleInHistory includes reverse pre-lock recovery", () => {
  assert.ok(
    htlcOrderVisibleInHistory({
      direction: "canton-to-evm",
      counterMode: "loop",
      status: "main_locking",
      evmFloatReserved: true
    })
  );
});

test("filterVisibleHtlcHistoryOrders drops unpaid rows", () => {
  const visible = filterVisibleHtlcHistoryOrders([
    {
      id: "0x" + "1".repeat(64),
      direction: "canton-to-evm",
      counterMode: "loop",
      status: "main_locking",
      evmFloatReserved: true
    },
    {
      id: "0x" + "3".repeat(64),
      direction: "canton-to-evm",
      status: "main_locking"
    },
    {
      id: "0x" + "2".repeat(64),
      direction: "canton-to-evm",
      status: "main_locked",
      counterTransferOfferCid: "cid"
    }
  ]);
  assert.equal(visible.length, 2);
});

test("filterVisibleC2cHistoryOrders drops unpaid loop open rows", () => {
  const visible = filterVisibleC2cHistoryOrders([
    { id: "a", walletMode: "loop", status: "open" },
    {
      id: "b",
      walletMode: "loop",
      status: "user_locked",
      userLegOfferCid: "cid"
    }
  ]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.id, "b");
});
