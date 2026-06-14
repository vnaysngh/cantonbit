import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  AMULET_HOLDING_TEMPLATE_FQN,
  isAllocationContract,
  isPlainChangeOutput,
  pickAllocationCid
} from "./htlc-allocation-pick";

const AMULET_ALLOC = "pkg:Splice.AmuletAllocation:AmuletAllocation";
const CBTC_HOLDING =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Holding:Holding";
const CBTC_ALLOC =
  "8107899ac4723ce986bf7d27416534e576e54b92161e46150a595fb78ff3d3a1:Utility.Registry.Holding.V0.Allocation:DvpLegAllocation";

test("pickAllocationCid skips Amulet change and picks AmuletAllocation", () => {
  const created = [
    { contractId: "amulet-change-cid", templateId: AMULET_HOLDING_TEMPLATE_FQN },
    { contractId: "alloc-cid", templateId: AMULET_ALLOC }
  ];
  assert.equal(pickAllocationCid(created), "alloc-cid");
});

test("pickAllocationCid skips CBTC Holding change and picks DvpLegAllocation", () => {
  const created = [
    { contractId: "holding-cid", templateId: CBTC_HOLDING },
    { contractId: "alloc-cid", templateId: CBTC_ALLOC }
  ];
  assert.equal(pickAllocationCid(created), "alloc-cid");
});

test("isPlainChangeOutput and isAllocationContract classify templates", () => {
  assert.equal(isPlainChangeOutput(AMULET_HOLDING_TEMPLATE_FQN), true);
  assert.equal(isPlainChangeOutput(CBTC_HOLDING), true);
  assert.equal(isAllocationContract(AMULET_ALLOC), true);
  assert.equal(isAllocationContract(AMULET_HOLDING_TEMPLATE_FQN), false);
});
