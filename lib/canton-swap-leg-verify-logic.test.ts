import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFillIncludesUserLegConsumption,
  assertOfferOnlyUserLegEvidence,
  buildLoopFillResultFromEvents,
  counterOfferConsumedInEvents,
  counterLegDeliveredToUserInEvents,
  extractCounterOfferCidFromEvents,
  parseUserLegEvidenceFromEvents
} from "./canton-swap-leg-verify-logic";
import { LOOP_USER_LEG_PREAPPROVAL_SETTLED } from "./canton-swap-order-logic";
import { NETWORK } from "./constants";
import { buildTransferMeta } from "./transfer-options";

const orderParams = {
  userParty: "user::1",
  solverParty: "solver::1",
  inAmount: "0.001",
  fromAsset: "CBTC" as const,
  expectedInstrument: NETWORK.instrumentId
};

const TRANSFER_IFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

test("parseUserLegEvidenceFromEvents: finds pending offer", () => {
  const evidence = parseUserLegEvidenceFromEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "offer-1",
            templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "user::1",
                    receiver: "solver::1",
                    amount: "0.00100000",
                    instrumentId: NETWORK.instrumentId
                  }
                }
              }
            ]
          }
        }
      }
    },
    orderParams
  );
  assert.equal(evidence?.offerCid, "offer-1");
});

test("parseUserLegEvidenceFromEvents: finds preapproval inbound holding", () => {
  const evidence = parseUserLegEvidenceFromEvents(
    {
      "5": {
        CreatedTreeEvent: {
          value: {
            contractId: "holding-solver",
            templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
            createArgument: {
              owner: "solver::1",
              amount: "0.0010000000",
              instrument: { id: "CBTC", admin: NETWORK.instrumentId.admin }
            }
          }
        }
      }
    },
    orderParams
  );
  assert.equal(evidence?.inboundHoldingCid, "holding-solver");
});

test("parseUserLegEvidenceFromEvents: rejects wrong sender", () => {
  const evidence = parseUserLegEvidenceFromEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "offer-1",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "attacker::1",
                    receiver: "solver::1",
                    amount: "0.00100000"
                  }
                }
              }
            ]
          }
        }
      }
    },
    orderParams
  );
  assert.equal(evidence, null);
});

test("parseUserLegEvidenceFromEvents: rejects wrong instrument on offer branch", () => {
  const evidence = parseUserLegEvidenceFromEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "cc-offer",
            templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "user::1",
                    receiver: "solver::1",
                    amount: "0.0010000000",
                    instrumentId: { admin: "cc-admin", id: "Amulet" }
                  }
                }
              }
            ]
          }
        }
      }
    },
    orderParams
  );
  assert.equal(evidence, null);
});

test("parseUserLegEvidenceFromEvents: rejects another order-bound memo", () => {
  const evidence = parseUserLegEvidenceFromEvents(
    {
      "1": {
        CreatedTreeEvent: {
          value: {
            contractId: "other-order-offer",
            templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "user::1",
                    receiver: "solver::1",
                    amount: "0.00100000",
                    instrumentId: NETWORK.instrumentId,
                    meta: buildTransferMeta("oranj.c2c.v1.other")
                  }
                }
              }
            ]
          }
        }
      }
    },
    {
      ...orderParams,
      expectedMemo: "oranj.c2c.v1.expected"
    }
  );
  assert.equal(evidence, null);
});

test("counterOfferConsumedInEvents: detects Accept on counter offer", () => {
  assert.equal(
    counterOfferConsumedInEvents(
      {
        "1": {
          ExercisedTreeEvent: {
            value: {
              contractId: "counter-offer",
              choice: "TransferInstruction_Accept"
            }
          }
        }
      },
      "counter-offer"
    ),
    true
  );
  assert.equal(
    counterOfferConsumedInEvents(
      {
        "1": {
          ExercisedTreeEvent: {
            value: {
              contractId: "counter-offer",
              choice: "TransferInstruction_Reject"
            }
          }
        }
      },
      "counter-offer"
    ),
    false
  );
});

test("counterLegDeliveredToUserInEvents: registry holding may omit instrument admin", () => {
  assert.equal(
    counterLegDeliveredToUserInEvents(
      {
        "0": {
          ExercisedTreeEvent: {
            value: {
              choice: "TransferRule_DirectTransfer",
              choiceArgument: {
                transfer: {
                  sender: "solver::1",
                  receiver: "user::1",
                  amount: "0.0000991600",
                  instrumentId: NETWORK.instrumentId
                }
              },
              exerciseResult: { receiverHoldingCid: "holding-user" }
            }
          }
        },
        "1": {
          CreatedTreeEvent: {
            value: {
              contractId: "holding-user",
              templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
              createArgument: {
                owner: "user::1",
                amount: "0.0000991600",
                instrumentId: { id: "CBTC" }
              }
            }
          }
        }
      },
      {
        senderParty: "solver::1",
        receiverParty: "user::1",
        amount: "0.00009916",
        amountDecimals: 8,
        expectedInstrument: NETWORK.instrumentId
      }
    ),
    true
  );
});

test("counterLegDeliveredToUserInEvents: requires sender-bound direct settlement", () => {
  assert.equal(
    counterLegDeliveredToUserInEvents(
      {
        "0": {
          ExercisedTreeEvent: {
            value: {
              templateId: "pkg:TransferFactory",
              choice: "TransferFactory_Transfer",
              choiceArgument: {
                transfer: {
                  sender: "solver::1",
                  receiver: "user::1",
                  amount: "10",
                  instrumentId: { id: "Amulet", admin: "dso::1" }
                }
              }
            }
          }
        },
        "1": {
          CreatedTreeEvent: {
            value: {
              contractId: "holding-user",
              templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
              createArgument: {
                owner: "user::1",
                amount: "10",
                instrument: { id: "Amulet", admin: "dso::1" }
              }
            }
          }
        }
      },
      {
        senderParty: "solver::1",
        receiverParty: "user::1",
        amount: "10",
        amountDecimals: 10,
        expectedInstrument: { admin: "dso::1", id: "Amulet" }
      }
    ),
    true
  );
});

test("counterLegDeliveredToUserInEvents: Amulet preapproval credits without registry holding", () => {
  const memo = "oranj.c2c.v1.test";
  assert.equal(
    counterLegDeliveredToUserInEvents(
      {
        "0": {
          ExercisedTreeEvent: {
            value: {
              choice: "TransferPreapproval_SendV2",
              choiceArgument: {
                sender: "solver::1",
                amount: "39.9581754384",
                description: memo
              },
              exerciseResult: {
                result: {
                  summary: {
                    balanceChanges: [
                      [
                        "solver::1",
                        {
                          changeToInitialAmountAsOfRoundZero: "-46.0310228874"
                        }
                      ],
                      [
                        "user::1",
                        {
                          changeToInitialAmountAsOfRoundZero: "46.3000563728"
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
        senderParty: "solver::1",
        receiverParty: "user::1",
        amount: "39.9581754384",
        amountDecimals: 10,
        expectedInstrument: { admin: "dso::1", id: "Amulet" },
        expectedMemo: memo
      }
    ),
    true
  );
});

test("counterLegDeliveredToUserInEvents: unrelated holding is not delivery proof", () => {
  assert.equal(
    counterLegDeliveredToUserInEvents(
      {
        "1": {
          CreatedTreeEvent: {
            value: {
              contractId: "holding-user",
              templateId: "pkg:Utility.Registry.Holding.V0.Holding:Holding",
              createArgument: {
                owner: "user::1",
                amount: "10",
                instrument: { id: "Amulet", admin: "dso::1" }
              }
            }
          }
        }
      },
      {
        senderParty: "solver::1",
        receiverParty: "user::1",
        amount: "10",
        amountDecimals: 10,
        expectedInstrument: { admin: "dso::1", id: "Amulet" }
      }
    ),
    false
  );
});

test("counterLegDeliveredToUserInEvents: pending offer is not direct delivery", () => {
  assert.equal(
    counterLegDeliveredToUserInEvents(
      {
        b: {
          CreatedTreeEvent: {
            value: {
              contractId: "counter-offer",
              templateId: "pkg:TransferInstruction",
              interfaceViews: [
                {
                  interfaceId: TRANSFER_IFACE,
                  viewValue: {
                    transfer: {
                      sender: "solver::1",
                      receiver: "user::1",
                      amount: "10"
                    }
                  }
                }
              ]
            }
          }
        }
      },
      {
        senderParty: "solver::1",
        receiverParty: "user::1",
        amount: "10",
        amountDecimals: 10,
        expectedInstrument: { admin: "dso::1", id: "Amulet" }
      }
    ),
    false
  );
});

test("extractCounterOfferCidFromEvents: selects solver→user counter offer", () => {
  const cid = extractCounterOfferCidFromEvents(
    {
      a: {
        CreatedTreeEvent: {
          value: {
            contractId: "accept-artifact",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "user::1",
                    receiver: "solver::1",
                    amount: "0.001"
                  }
                }
              }
            ]
          }
        }
      },
      b: {
        CreatedTreeEvent: {
          value: {
            contractId: "counter-offer",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "solver::1",
                    receiver: "user::1",
                    amount: "10"
                  }
                }
              }
            ]
          }
        }
      }
    },
    {
      senderParty: "solver::1",
      receiverParty: "user::1",
      amount: "10",
      amountDecimals: 10
    }
  );
  assert.equal(cid, "counter-offer");
});

test("extractCounterOfferCidFromEvents: selects exact memo over same-amount counter offer", () => {
  const cid = extractCounterOfferCidFromEvents(
    {
      a: {
        CreatedTreeEvent: {
          value: {
            contractId: "wrong-memo",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "solver::1",
                    receiver: "user::1",
                    amount: "10",
                    meta: buildTransferMeta("oranj.c2c.v1.other")
                  }
                }
              }
            ]
          }
        }
      },
      b: {
        CreatedTreeEvent: {
          value: {
            contractId: "expected-memo",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId: TRANSFER_IFACE,
                viewValue: {
                  transfer: {
                    sender: "solver::1",
                    receiver: "user::1",
                    amount: "10",
                    meta: buildTransferMeta("oranj.c2c.v1.expected")
                  }
                }
              }
            ]
          }
        }
      }
    },
    {
      senderParty: "solver::1",
      receiverParty: "user::1",
      amount: "10",
      amountDecimals: 10,
      expectedMemo: "oranj.c2c.v1.expected"
    }
  );
  assert.equal(cid, "expected-memo");
});

test("assertFillIncludesUserLegConsumption: blocks deliver-only without pending offer", () => {
  assert.throws(
    () =>
      assertFillIncludesUserLegConsumption({
        userLegOfferCid: LOOP_USER_LEG_PREAPPROVAL_SETTLED,
        acceptLegIncluded: false,
        isPendingOffer: false
      }),
    /requires pending user leg offer/
  );
});

test("assertFillIncludesUserLegConsumption: requires accept for pending offer", () => {
  assert.throws(
    () =>
      assertFillIncludesUserLegConsumption({
        userLegOfferCid: "offer-1",
        acceptLegIncluded: false,
        isPendingOffer: true
      }),
    /must accept pending/
  );
});

test("assertFillIncludesUserLegConsumption: accepts pending offer with accept leg", () => {
  assertFillIncludesUserLegConsumption({
    userLegOfferCid: "offer-1",
    acceptLegIncluded: true,
    isPendingOffer: true
  });
});

test("assertOfferOnlyUserLegEvidence: rejects preapproval inbound holding", () => {
  assert.throws(
    () =>
      assertOfferOnlyUserLegEvidence({ inboundHoldingCid: "holding-1" }),
    /preapproval auto-accept/
  );
});

test("assertOfferOnlyUserLegEvidence: accepts pending offer", () => {
  assertOfferOnlyUserLegEvidence({ offerCid: "offer-1" });
});
