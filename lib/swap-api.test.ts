import assert from "node:assert/strict";
import test from "node:test";

import { getSwapErrorMessage, USER_REJECTED_MESSAGE } from "./swap-api";

test("getSwapErrorMessage maps EIP-1193 user rejection objects", () => {
  assert.equal(
    getSwapErrorMessage({ code: 4001, message: "User rejected the request." }),
    USER_REJECTED_MESSAGE,
  );
});

test("getSwapErrorMessage does not leak object-object placeholders", () => {
  assert.equal(getSwapErrorMessage(new Error("[object Object]")), "Something went wrong. Please try again.");
  assert.equal(getSwapErrorMessage({}), "Something went wrong. Please try again.");
});

test("getSwapErrorMessage extracts nested provider messages", () => {
  assert.equal(
    getSwapErrorMessage({ error: { message: "execution reverted" } }),
    "execution reverted",
  );
});
