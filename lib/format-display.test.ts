import assert from "node:assert/strict";
import test from "node:test";

import { formatBtcDisplay, formatCc, formatDisplayAmount } from "./format";

test("formatCc rounds to at most 2 decimal places", () => {
  assert.equal(formatCc("89.3640503689"), "89.36");
  assert.equal(formatCc("1.5"), "1.5");
  assert.equal(formatCc("100"), "100");
  assert.equal(formatCc(null), "0");
});

test("formatBtcDisplay caps at 5 decimal places", () => {
  assert.equal(formatBtcDisplay("0.00002000"), "0.00002");
  assert.equal(formatBtcDisplay("1.123456789"), "1.12346");
});

test("formatDisplayAmount trims trailing zeros", () => {
  assert.equal(formatDisplayAmount("10.50", 2), "10.5");
});
