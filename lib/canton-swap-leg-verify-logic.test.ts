import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFillIncludesUserLegConsumption,
  assertOfferOnlyUserLegEvidence,
  extractCounterOfferCidFromEvents,
  parseUserLegEvidenceFromEvents
} from "./canton-swap-leg-verify-logic";
import { LOOP_USER_LEG_PREAPPROVAL_SETTLED } from "./canton-swap-order-logic";
import { NETWORK } from "./constants";

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
              instrument: { id: "CBTC" }
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
