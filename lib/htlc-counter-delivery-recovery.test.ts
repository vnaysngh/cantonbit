import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverHtlcCounterDeliveryFromEvents } from "./htlc-counter-delivery-recovery";

const instrument = { admin: "cbtc-network::admin", id: "CBTC" };
const params = {
  senderParty: "solver::1",
  receiverParty: "user::1",
  amountBtc: "0.125",
  expectedInstrument: instrument
};

test("counter delivery recovery returns the exact pending offer", () => {
  const recovered = recoverHtlcCounterDeliveryFromEvents(
    {
      offer: {
        CreatedTreeEvent: {
          value: {
            contractId: "offer-cid",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId:
                  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                viewValue: {
                  transfer: {
                    sender: params.senderParty,
                    receiver: params.receiverParty,
                    amount: params.amountBtc,
                    instrumentId: instrument
                  }
                }
              }
            ]
          }
        }
      }
    },
    params
  );

  assert.deepEqual(recovered, { delivered: false, offerCid: "offer-cid" });
});

test("counter delivery recovery proves direct delivery from receiver holding", () => {
  const recovered = recoverHtlcCounterDeliveryFromEvents(
    {
      transfer: {
        ExercisedTreeEvent: {
          value: {
            templateId: "pkg:TransferFactory",
            choice: "TransferFactory_Transfer",
            choiceArgument: {
              transfer: {
                sender: params.senderParty,
                receiver: params.receiverParty,
                amount: params.amountBtc,
                instrumentId: instrument
              }
            }
          }
        }
      },
      holding: {
        CreatedTreeEvent: {
          value: {
            contractId: "holding-cid",
            templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
            createArgument: {
              owner: params.receiverParty,
              amount: params.amountBtc,
              instrumentId: instrument
            }
          }
        }
      }
    },
    params
  );

  assert.deepEqual(recovered, { delivered: true });
});

test("counter delivery recovery prefers direct delivery when offer artifact also exists", () => {
  const recovered = recoverHtlcCounterDeliveryFromEvents(
    {
      offer: {
        CreatedTreeEvent: {
          value: {
            contractId: "transient-offer-cid",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId:
                  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                viewValue: {
                  transfer: {
                    sender: params.senderParty,
                    receiver: params.receiverParty,
                    amount: params.amountBtc,
                    instrumentId: instrument
                  }
                }
              }
            ]
          }
        }
      },
      transfer: {
        ExercisedTreeEvent: {
          value: {
            templateId: "pkg:TransferFactory",
            choice: "TransferFactory_Transfer",
            choiceArgument: {
              transfer: {
                sender: params.senderParty,
                receiver: params.receiverParty,
                amount: params.amountBtc,
                instrumentId: instrument
              }
            }
          }
        }
      },
      holding: {
        CreatedTreeEvent: {
          value: {
            contractId: "holding-cid",
            templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
            createArgument: {
              owner: params.receiverParty,
              amount: params.amountBtc,
              instrumentId: instrument
            }
          }
        }
      }
    },
    params
  );

  assert.deepEqual(recovered, { delivered: true });
});

test("counter delivery recovery proves registry direct transfer with memo and padded amount", () => {
  const memo =
    "oranj.htlc.fwd.v1.eyJpZCI6InRlc3QifQ";
  const recovered = recoverHtlcCounterDeliveryFromEvents(
    {
      factory: {
        ExercisedTreeEvent: {
          value: {
            choice: "TransferFactory_Transfer",
            choiceArgument: {
              transfer: {
                sender: params.senderParty,
                receiver: params.receiverParty,
                amount: "0.0000991600",
                instrumentId: instrument,
                meta: {
                  values: {
                    "splice.lfdecentralizedtrust.org/reason": memo
                  }
                }
              }
            },
            exerciseResult: {
              output: {
                tag: "TransferInstructionResult_Completed",
                value: { receiverHoldingCids: ["holding-cid"] }
              }
            }
          }
        }
      },
      rule: {
        ExercisedTreeEvent: {
          value: {
            choice: "TransferRule_DirectTransfer",
            choiceArgument: {
              transfer: {
                sender: params.senderParty,
                receiver: params.receiverParty,
                amount: "0.0000991600",
                instrumentId: instrument,
                meta: {
                  values: {
                    "splice.lfdecentralizedtrust.org/reason": memo
                  }
                }
              }
            },
            exerciseResult: {
              receiverHoldingCid: "holding-cid"
            }
          }
        }
      },
      holding: {
        CreatedTreeEvent: {
          value: {
            contractId: "holding-cid",
            templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
            createArgument: {
              owner: params.receiverParty,
              amount: "0.0000991600",
              instrumentId: instrument
            }
          }
        }
      }
    },
    { ...params, amountBtc: "0.00009916", expectedMemo: memo }
  );

  assert.deepEqual(recovered, { delivered: true });
});

test("counter delivery recovery fails closed without matching ledger evidence", () => {
  const recovered = recoverHtlcCounterDeliveryFromEvents(
    {
      wrongAsset: {
        CreatedTreeEvent: {
          value: {
            contractId: "wrong-offer",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId:
                  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                viewValue: {
                  transfer: {
                    sender: params.senderParty,
                    receiver: params.receiverParty,
                    amount: params.amountBtc,
                    instrumentId: { admin: "dso::1", id: "Amulet" }
                  }
                }
              }
            ]
          }
        }
      }
    },
    params
  );

  assert.equal(recovered, null);
});
