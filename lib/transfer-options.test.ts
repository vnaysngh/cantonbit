import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransferMeta,
  TRANSFER_REASON_META_KEY
} from "./transfer-options";

test("buildTransferMeta sets splice reason key", () => {
  const meta = buildTransferMeta("invoice #42");
  assert.equal(meta.values[TRANSFER_REASON_META_KEY], "invoice #42");
});

test("buildTransferMeta returns empty values when memo blank", () => {
  assert.deepEqual(buildTransferMeta("  ").values, {});
});
