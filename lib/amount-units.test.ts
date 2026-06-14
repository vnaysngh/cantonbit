import assert from "node:assert/strict";
import test from "node:test";

import { fromBaseUnits, toBaseUnits, toBaseUnitsFloor } from "./amount-units";

test("toBaseUnitsFloor truncates excess fractional digits", () => {
  assert.equal(toBaseUnitsFloor("44.757698689", 8), toBaseUnits("44.75769868", 8));
});

test("fromBaseUnits does not round up display balance", () => {
  assert.equal(fromBaseUnits(toBaseUnitsFloor("44.75769868", 10), 10), "44.75769868");
});
