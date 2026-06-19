import assert from "node:assert/strict";
import { test } from "node:test";

import { safeRedirectPath } from "./safe-redirect-path";

test("safeRedirectPath allows normal relative paths", () => {
  assert.equal(safeRedirectPath("/swap"), "/swap");
  assert.equal(safeRedirectPath("/orders/abc"), "/orders/abc");
});

test("safeRedirectPath blocks open redirects", () => {
  assert.equal(safeRedirectPath("//evil.com"), "/swap");
  assert.equal(safeRedirectPath("https://evil.com"), "/swap");
  assert.equal(safeRedirectPath("/\\evil"), "/swap");
});

test("safeRedirectPath falls back when empty", () => {
  assert.equal(safeRedirectPath(null), "/swap");
  assert.equal(safeRedirectPath(""), "/swap");
});
