import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recoverExactAllocationFromEvents,
  recoverExactHtlcLockFromEvents
} from "./htlc-ledger-recovery";

const instrument = { admin: "cbtc::admin", id: "CBTC" };

test("recovers an exact committed reverse Allocation", () => {
  const settleBefore = new Date("2026-06-21T12:00:00.000Z");
  const result = recoverExactAllocationFromEvents(
    {
      one: {
        CreatedTreeEvent: {
          value: {
            contractId: "alloc-1",
            templateId: "pkg:Allocation:DvpLegAllocation",
            createArgument: {
              settlement: {
                executor: "solver::1",
                settlementRef: { id: "htlc-rev-abc" },
                settleBefore: settleBefore.toISOString()
              },
              transferLeg: {
                sender: "user::1",
                receiver: "solver::1",
                amount: "0.01000000",
                instrumentId: instrument
              }
            }
          }
        }
      }
    },
    {
      settlementId: "htlc-rev-abc",
      senderParty: "user::1",
      receiverParty: "solver::1",
      executorParty: "solver::1",
      amountBtc: "0.01",
      instrumentId: instrument,
      settleBefore
    }
  );
  assert.deepEqual(result, { allocationCid: "alloc-1" });
});

test("rejects a committed Allocation with mismatched amount", () => {
  const settleBefore = new Date("2026-06-21T12:00:00.000Z");
  assert.throws(
    () =>
      recoverExactAllocationFromEvents(
        {
          one: {
            CreatedTreeEvent: {
              value: {
                contractId: "alloc-1",
                templateId: "pkg:Allocation:DvpLegAllocation",
                createArgument: {
                  settlement: {
                    executor: "solver::1",
                    settlementRef: { id: "htlc-rev-abc" },
                    settleBefore: settleBefore.toISOString()
                  },
                  transferLeg: {
                    sender: "user::1",
                    receiver: "solver::1",
                    amount: "0.02",
                    instrumentId: instrument
                  }
                }
              }
            }
          }
        },
        {
          settlementId: "htlc-rev-abc",
          senderParty: "user::1",
          receiverParty: "solver::1",
          executorParty: "solver::1",
          amountBtc: "0.01",
          instrumentId: instrument,
          settleBefore
        }
      ),
    /terms do not match/
  );
});

test("recovers an exact committed HtlcLock", () => {
  const unlockTime = new Date("2026-06-21T11:59:00.000Z");
  const result = recoverExactHtlcLockFromEvents(
    {
      one: {
        CreatedTreeEvent: {
          value: {
            contractId: "htlc-1",
            templateId: "pkg:CbtcHtlc:HtlcLock",
            createdEventBlob: "blob",
            createArgument: {
              locker: "user::1",
              receiver: "solver::1",
              executor: "solver::1",
              allocationCid: "alloc-1",
              amount: "0.01",
              instrumentId: instrument,
              hashLock: "aa".repeat(32),
              unlockTime: unlockTime.toISOString()
            }
          }
        }
      }
    },
    {
      lockerParty: "user::1",
      receiverParty: "solver::1",
      executorParty: "solver::1",
      allocationCid: "alloc-1",
      amountBtc: "0.01",
      instrumentId: instrument,
      hashLock: `0x${"aa".repeat(32)}`,
      unlockTime
    }
  );
  assert.deepEqual(result, { htlcCid: "htlc-1", htlcBlob: "blob" });
});
