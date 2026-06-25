import assert from "node:assert/strict";
import test from "node:test";

import { getSwapErrorMessage, getLoopSignErrorMessage, USER_REJECTED_MESSAGE } from "./swap-api";

test("getSwapErrorMessage maps EIP-1193 user rejection objects", () => {
  assert.equal(
    getSwapErrorMessage({ code: 4001, message: "User rejected the request." }),
    USER_REJECTED_MESSAGE,
  );
});

test("getLoopSignErrorMessage maps Loop popup closed without generic decline", () => {
  assert.match(
    getLoopSignErrorMessage({ name: "PopupClosedError", message: "closed" }) ?? "",
    /Try again|Orders/i
  );
});

test("getSwapErrorMessage suppresses transient EVM finality polling errors", () => {
  assert.equal(
    getSwapErrorMessage(
      new Error("EVM transaction awaiting finality (1/3 confirmations)")
    ),
    ""
  );
});

test("getSwapErrorMessage maps phantom EVM claim / gas limit errors", () => {
  assert.equal(
    getSwapErrorMessage(new Error("RPC submit: exceeds max transaction gas limit")),
    "No WBTC is locked on-chain for this swap — the solver counter-lock did not land. Your CBTC is still safe; wait for the solver to retry or refund after the timelock."
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
