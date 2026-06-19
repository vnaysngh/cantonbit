import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertReverseCounterLockMatches,
  parseLockedEventData
} from "./htlc-evm-counter-lock";

const WBTC = "0x8d587e55236d1d4898e85711f709e53e657413ee";
const USER = "0x05f6e2f2f196db4cd964b230ac95edfb436c7461";

test("parseLockedEventData decodes Locked log data words", () => {
  const unlock = 1_781_878_837;
  const amount = 9907n;
  const token = WBTC.slice(2).padStart(64, "0");
  const sender = "0x0b95ec21579aee6ef7b712976bd86689d68b5a08".slice(2).padStart(64, "0");
  const receiver = USER.slice(2).padStart(64, "0");
  const data =
    "0x" +
    unlock.toString(16).padStart(64, "0") +
    amount.toString(16).padStart(64, "0") +
    token +
    sender +
    receiver;
  const parsed = parseLockedEventData(data);
  assert.equal(parsed.unlockTime, unlock);
  assert.equal(parsed.amount, amount);
  assert.equal(parsed.tokenAddress, WBTC.toLowerCase());
  assert.equal(parsed.receiverAddress, USER.toLowerCase());
});

test("assertReverseCounterLockMatches rejects wrong receiver", () => {
  assert.throws(
    () =>
      assertReverseCounterLockMatches(
        {
          unlockTime: 100,
          amount: 10_000n,
          tokenAddress: WBTC,
          senderAddress: "0x1",
          receiverAddress: "0x2"
        },
        {
          hashLock: "0xabc",
          wbtcAmount: "9907",
          userEvmAddress: USER,
          solverTimelock: 100,
          expectedWbtcAddress: WBTC
        }
      ),
    /receiver is not the user's EVM address/
  );
});

test("assertReverseCounterLockMatches accepts matching lock", () => {
  assert.doesNotThrow(() =>
    assertReverseCounterLockMatches(
      {
        unlockTime: 0,
        amount: 10_000n,
        tokenAddress: WBTC,
        senderAddress: "0x1",
        receiverAddress: USER
      },
      {
        hashLock: "0xabc",
        wbtcAmount: "9907",
        userEvmAddress: USER,
        solverTimelock: 100,
        expectedWbtcAddress: WBTC
      }
    )
  );
});

test("verifyReverseCounterLockTx rejects phantom tx (stuck-order regression)", async () => {
  const { verifyReverseCounterLockTx } = await import("./htlc-evm-counter-lock.js");
  await assert.rejects(
    () =>
      verifyReverseCounterLockTx(
        "0x1abe803ea0450c881c1197ad8728c996a5ebd750610d484a430587dac950078d",
        {
          hashLock:
            "0xbbf74e92dcef5367459c197bb4a606e3f0f49d8df1a74a0d46370a036026e9cc",
          wbtcAmount: "9907",
          userEvmAddress: USER,
          solverTimelock: 1781882437,
          expectedWbtcAddress: WBTC
        }
      ),
    /not found on Base Sepolia/
  );
});
