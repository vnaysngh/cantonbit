import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ccNetworkFeePaidInEvents,
  disclosedCcTransferPreapprovalCid
} from "./network-fee-verify-logic";
import { TRANSFER_INSTRUCTION_INTERFACE } from "./transfer-instruction-read";

const USER = "user::1220abc";
const FEE_RECEIVER = "warpx-mainnet-1::1220fee";
const CC_INST = { admin: "dso::1220dso", id: "Amulet" };
const PREAPPROVAL_CID = "preapproval-cid";

test("disclosedCcTransferPreapprovalCid binds the exact prepared contract", () => {
  assert.equal(
    disclosedCcTransferPreapprovalCid([
      {
        templateId: "pkg:Splice.AmuletRules:TransferPreapproval",
        contractId: PREAPPROVAL_CID
      },
      { templateId: "pkg:Splice.Amulet:Amulet", contractId: "holding-cid" }
    ]),
    PREAPPROVAL_CID
  );
});

test("disclosedCcTransferPreapprovalCid rejects missing or ambiguous bindings", () => {
  assert.equal(disclosedCcTransferPreapprovalCid([]), null);
  assert.equal(
    disclosedCcTransferPreapprovalCid([
      {
        templateId: "pkg:Splice.AmuletRules:TransferPreapproval",
        contractId: "cid-1"
      },
      {
        templateId: "pkg:Splice.AmuletRules:TransferPreapproval",
        contractId: "cid-2"
      }
    ]),
    null
  );
});

// H-01: a bare TransferInstruction/TransferOffer is a PENDING offer (funds offered,
// not received) — it can still expire/be rejected, so it must NOT count as paid.
test("ccNetworkFeePaidInEvents: rejects a pending transfer instruction (offer, not settled)", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
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
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
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

// P1: a synthetic exercise (wrong choice + unrelated template) carrying transfer-
// shaped fields must NOT pass — only a real settling transfer choice/template counts.
test("ccNetworkFeePaidInEvents: rejects a Noop exercise with transfer-shaped fields", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            choice: "Noop",
            templateId: "pkg:Whatever:Thing",
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

test("ccNetworkFeePaidInEvents: rejects a spoofed TransferFactory template name", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            choice: "Noop",
            templateId: "pkg:Fake:TransferFactory",
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

test("ccNetworkFeePaidInEvents: rejects pending offer even when factory exercise is present", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            choice: "TransferFactory_Transfer",
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
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
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

// Network-fee policy requires the configured receiver's direct CC preapproval;
// a generic instruction path is not accepted as fee proof.
test("ccNetworkFeePaidInEvents: rejects generic auto-settled transfer instruction", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            choice: "TransferFactory_Transfer",
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
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            templateId: TRANSFER_INSTRUCTION_INTERFACE,
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
      },
      "2": {
        ExercisedTreeEvent: {
          value: {
            contractId: "cid-fee-offer",
            choice: "TransferInstruction_Accept",
            choiceArgument: {}
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

// A transfer-shaped exercise is not settlement evidence by itself. WarpX direct
// preapproval payments are proven separately via TransferPreapproval_SendV2.
test("ccNetworkFeePaidInEvents: rejects direct exercise without settlement result", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "1": {
        ExercisedTreeEvent: {
          value: {
            templateId: "pkg:TransferFactory",
            choice: "TransferFactory_Transfer",
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

test("ccNetworkFeePaidInEvents: accepts WarpX TransferPreapproval_SendV2 proof", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            contractId: PREAPPROVAL_CID,
            choice: "TransferPreapproval_SendV2",
            templateId:
              "pkg:Splice.AmuletRules:TransferPreapproval",
            choiceArgument: {
              sender: USER,
              amount: "5.5000000000",
              inputs: []
            },
            exerciseResult: {
              result: {
                summary: {
                  balanceChanges: [
                    [
                      USER,
                      {
                        changeToInitialAmountAsOfRoundZero: "-5.5000000000"
                      }
                    ],
                    [
                      FEE_RECEIVER,
                      {
                        changeToInitialAmountAsOfRoundZero: "8.2500000000"
                      }
                    ]
                  ]
                }
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
      expectedInstrument: CC_INST,
      expectedPreapprovalCid: PREAPPROVAL_CID
    }
  );
  assert.equal(ok, true);
});

test("ccNetworkFeePaidInEvents: rejects SendV2 on another preapproval contract", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            contractId: "attacker-preapproval-cid",
            choice: "TransferPreapproval_SendV2",
            templateId: "pkg:Splice.AmuletRules:TransferPreapproval",
            choiceArgument: {
              sender: USER,
              amount: "5.5000000000"
            },
            exerciseResult: {
              result: {
                summary: {
                  balanceChanges: [
                    [
                      USER,
                      {
                        changeToInitialAmountAsOfRoundZero: "-5.5000000000"
                      }
                    ],
                    [
                      FEE_RECEIVER,
                      {
                        changeToInitialAmountAsOfRoundZero: "5.5000000000"
                      }
                    ]
                  ]
                }
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
      expectedInstrument: CC_INST,
      expectedPreapprovalCid: PREAPPROVAL_CID
    }
  );
  assert.equal(ok, false);
});

test("ccNetworkFeePaidInEvents: rejects preapproval send without receiver credit", () => {
  const ok = ccNetworkFeePaidInEvents(
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            contractId: PREAPPROVAL_CID,
            choice: "TransferPreapproval_SendV2",
            templateId:
              "pkg:Splice.AmuletRules:TransferPreapproval",
            choiceArgument: {
              sender: USER,
              amount: "5.5000000000"
            },
            exerciseResult: {
              result: {
                summary: {
                  balanceChanges: [
                    [
                      USER,
                      {
                        changeToInitialAmountAsOfRoundZero: "-5.5000000000"
                      }
                    ],
                    [
                      "other-receiver",
                      {
                        changeToInitialAmountAsOfRoundZero: "5.5000000000"
                      }
                    ]
                  ]
                }
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
      expectedInstrument: CC_INST,
      expectedPreapprovalCid: PREAPPROVAL_CID
    }
  );
  assert.equal(ok, false);
});

// A receiver Holding cannot link itself to the alleged sender; require a consumed
// TransferInstruction or SendV2 balance-change result.
test("ccNetworkFeePaidInEvents: rejects receiver Holding with only transfer-shaped arguments", () => {
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
  assert.equal(ok, false);
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
