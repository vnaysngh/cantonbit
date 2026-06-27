import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  collectUsedLoopCustodyCids,
  isCustodyEvidenceConflictError,
  isSafeReversePrelockReleaseCause
} from "./htlc-loop-custody-logic";

test("collectUsedLoopCustodyCids includes completed orders, not just active", () => {
  const used = collectUsedLoopCustodyCids(
    [
      { id: "0xdone", counterTransferOfferCid: "cid-completed" },
      { id: "0xlive", counterTransferOfferCid: "cid-live" },
      { id: "0xempty" }
    ],
    "0xself"
  );
  assert.equal(used.size, 2);
  assert.ok(used.has("cid-completed"));
  assert.ok(used.has("cid-live"));
});

test("isCustodyEvidenceConflictError detects unique index failures", () => {
  assert.ok(
    isCustodyEvidenceConflictError(
      new Error(
        'htlc_orders putIfStatus: duplicate key value violates unique constraint "htlc_orders_counter_transfer_evidence_uidx"'
      )
    )
  );
  assert.ok(!isCustodyEvidenceConflictError(new Error("order not accepted")));
});

test("isSafeReversePrelockReleaseCause rejects broad infrastructure errors", () => {
  assert.ok(!isSafeReversePrelockReleaseCause(new Error("resource missing")));
  assert.ok(!isSafeReversePrelockReleaseCause(new Error("not found")));
});

test("isSafeReversePrelockReleaseCause covers ambiguous custody and duplicate evidence", () => {
  assert.ok(
    isSafeReversePrelockReleaseCause(
      new Error("ambiguous Loop custody deposit — multiple exact new holdings match this order")
    )
  );
  assert.ok(
    isSafeReversePrelockReleaseCause(
      new Error('duplicate key value violates unique constraint "htlc_orders_counter_transfer_evidence_uidx"')
    )
  );
  assert.ok(
    isSafeReversePrelockReleaseCause(
      new Error("Loop custody transfer is not visible on-ledger yet — confirmation will retry automatically.")
    )
  );
});
