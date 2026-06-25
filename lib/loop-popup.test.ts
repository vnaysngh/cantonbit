import assert from "node:assert/strict";
import test from "node:test";

import { isLoopPopupBlockedError, isPopupBlocked } from "./loop-popup";

test("isPopupBlocked treats null window as blocked", () => {
  assert.equal(isPopupBlocked(null), true);
});

test("isLoopPopupBlockedError detects PopupClosedError", () => {
  assert.equal(
    isLoopPopupBlockedError({ name: "PopupClosedError", message: "closed" }),
    true
  );
  assert.equal(
    isLoopPopupBlockedError(new Error("browser popup blocked for this site")),
    true
  );
});
