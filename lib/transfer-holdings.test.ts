import assert from "node:assert/strict";
import test from "node:test";

import { selectTransferHoldings } from "./transfer-holdings";
import type { Holding } from "./types";

function holding(contractId: string, amountBtc: string): Holding {
  return {
    contractId,
    payload: {
      owner: "test::1220",
      instrumentId: { admin: "admin::1220", id: "CBTC" },
      amount: amountBtc
    }
  };
}

test("selectTransferHoldings picks smallest holdings first", () => {
  const picked = selectTransferHoldings(
    [
      holding("large", "1.0"),
      holding("small", "0.00001"),
      holding("med", "0.001")
    ],
    "0.000015"
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].contractId, "small");
  assert.equal(picked[1].contractId, "med");
});

test("selectTransferHoldings throws on insufficient balance", () => {
  assert.throws(
    () => selectTransferHoldings([holding("a", "0.00001")], "0.1"),
    /Insufficient balance/
  );
});

test("selectTransferHoldings uses CC precision (10dp)", () => {
  const ccHolding = (contractId: string, amount: string): Holding => ({
    contractId,
    payload: {
      owner: "test::1220",
      instrumentId: { admin: "DSO::1220", id: "Amulet" },
      amount
    }
  });
  assert.throws(
    () =>
      selectTransferHoldings(
        [ccHolding("a", "44.75769868")],
        "44.757699",
        "CC"
      ),
    /Insufficient balance: have 44\.75769868 CC, need 44\.757699 CC/
  );
  const picked = selectTransferHoldings(
    [ccHolding("a", "44.75769868")],
    "44.75769868",
    "CC"
  );
  assert.equal(picked.length, 1);
});
