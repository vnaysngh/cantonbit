import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ccNetworkFeePaidInEvents } from "./network-fee-verify-logic";

const USER = "user::1220abc";
const FEE_RECEIVER = "warpx-mainnet-1::1220fee";
const CC_INST = { admin: "dso::1220dso", id: "Amulet" };

// H-01: a bare TransferInstruction/TransferOffer is a PENDING offer (funds offered,
// not received) — it can still expire/be rejected, so it must NOT count as paid.
test("ccNetworkFeePaidInEvents: rejects a pending transfer instruction (offer, not settled)", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            templateId: "pkg:TransferInstruction",
            createArgument: {
              transfer: {
                sender: USER,
                receiver: FEE_RECEIVER,
                amount: "5.5",
                instrumentId: CC_INST
              }
            }
          }
        }
      }
    },
    {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST
    }
  );
  assert.equal(ok, false);
});

test("ccNetworkFeePaidInEvents: rejects wrong receiver", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            templateId: "pkg:TransferInstruction",
            createArgument: {
              transfer: {
                sender: USER,
                receiver: "other::party",
                amount: "5.5",
                instrumentId: CC_INST
              }
            }
          }
        }
      }
    },
    {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST
    }
  );
  assert.equal(ok, false);
});

// H-01: a bare CC Holding owned by the receiver does NOT prove who paid. An
// unrelated receiver-owned Holding (no sender-bound transfer in the tree) must be
// rejected — this is the exact bypass the re-audit reproduced.
test("ccNetworkFeePaidInEvents: rejects receiver Holding with NO sender-bound transfer", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-holding",
            templateId: "pkg:Splice.Amulet:Amulet",
            createArgument: {
              owner: FEE_RECEIVER,
              amount: "5.5",
              instrumentId: CC_INST
            }
          }
        }
      }
    },
    {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST
    }
  );
  assert.equal(ok, false);
});

// H-01: a receiver Holding IS acceptable when the same tree carries an exercised
// CC transfer FROM the user (the direct/preapproved path binds the payer).
test("ccNetworkFeePaidInEvents: accepts receiver Holding WITH a sender-bound transfer", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        ExercisedTreeEvent: {
          value: {
            templateId: "pkg:TransferFactory",
            choiceArgument: {
              transfer: {
                sender: USER,
                receiver: FEE_RECEIVER,
                amount: "5.5",
                instrumentId: CC_INST
              }
            }
          }
        }
      },
      "2": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-holding",
            templateId: "pkg:Splice.Amulet:Amulet",
            createArgument: {
              owner: FEE_RECEIVER,
              amount: "5.5",
              instrumentId: CC_INST
            }
          }
        }
      }
    },
    {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST
    }
  );
  assert.equal(ok, true);
});

// H-01: a receiver Holding with an exercised transfer from a DIFFERENT sender must
// still be rejected (the transfer must be from OUR user).
test("ccNetworkFeePaidInEvents: rejects receiver Holding when transfer sender is not the user", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        ExercisedTreeEvent: {
          value: {
            choiceArgument: {
              transfer: {
                sender: "stranger::1220xyz",
                receiver: FEE_RECEIVER,
                amount: "5.5",
                instrumentId: CC_INST
              }
            }
          }
        }
      },
      "2": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-holding",
            templateId: "pkg:Splice.Amulet:Amulet",
            createArgument: {
              owner: FEE_RECEIVER,
              amount: "5.5",
              instrumentId: CC_INST
            }
          }
        }
      }
    },
    {
      userParty: USER,
      receiverParty: FEE_RECEIVER,
      minFeeCc: "5",
      expectedInstrument: CC_INST
    }
  );
  assert.equal(ok, false);
});
