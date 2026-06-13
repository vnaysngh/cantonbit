import assert from "node:assert/strict";
import test from "node:test";

import { selectTransferHoldings } from "./transfer-holdings";

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
