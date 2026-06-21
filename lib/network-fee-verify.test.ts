import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ccNetworkFeePaidInEvents } from "./network-fee-verify-logic";
import { extractEventsByIdFromSubmitResult } from "./mint-processor-logic";

const USER =
  "party-loop::1220abc1111111111111111111111111111111111111111111111111111111111";
const FEE_RECEIVER =
  "warpx-devnet-1::1220fee1111111111111111111111111111111111111111111111111111111";
const DSO = "dso::1220dso1111111111111111111111111111111111111111111111111111111111";
const CC_INST = { admin: DSO, id: "Amulet" };
const PREAPPROVAL_CID = "preapproval-cid";

const DIRECT_FEE_EVENTS = {
  "1": {
    ExercisedTreeEvent: {
      value: {
        contractId: PREAPPROVAL_CID,
        templateId: "pkg:Splice.AmuletRules:TransferPreapproval",
        choice: "TransferPreapproval_SendV2",
        choiceArgument: {
          sender: USER,
          amount: "5.5"
        },
        exerciseResult: {
          result: {
            summary: {
              balanceChanges: [
                [
                  USER,
                  { changeToInitialAmountAsOfRoundZero: "-5.5000000000" }
                ],
                [
                  FEE_RECEIVER,
                  { changeToInitialAmountAsOfRoundZero: "5.5000000000" }
                ]
              ]
            }
          }
        }
      }
    }
  }
};

/** Loop SDK submitAndWaitForTransaction shape (what we now forward to the API). */
test("extractEventsByIdFromSubmitResult reads Loop update_data tree", () => {
  const events = extractEventsByIdFromSubmitResult({
    update_id: "0000000000000000000000000000000000000000000000000000000000000001",
    update_data: { eventsById: DIRECT_FEE_EVENTS }
  });
  assert.ok(events);
  assert.ok(
    ccNetworkFeePaidInEvents(events, {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST,
      expectedPreapprovalCid: PREAPPROVAL_CID
    })
  );
});

test("direct CC fee tree passes without receiver Holding (WarpX preapproval path)", () => {
  assert.ok(
    ccNetworkFeePaidInEvents(DIRECT_FEE_EVENTS, {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST,
      expectedPreapprovalCid: PREAPPROVAL_CID
    })
  );
});
