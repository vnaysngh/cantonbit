import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  findLoopOutgoingTransferOffer,
  normalizeLoopAcsResponse,
  parseOfferFromLoopAcsItem
} from "./loop-transfer-offers";

test("parseOfferFromLoopAcsItem: interface-filter shape without template string", () => {
  const item = {
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          contractId: "offer-abc",
          interfaceViews: [
            {
              viewValue: {
                transfer: {
                  sender: "user::1220",
                  receiver: "solver::1220",
                  amount: "0.00100000",
                  instrumentId: { admin: "cbtc-network::1220", id: "CBTC" }
                }
              }
            }
          ]
        }
      }
    }
  };
  const o = parseOfferFromLoopAcsItem(item);
  assert.ok(o);
  assert.equal(o!.contractId, "offer-abc");
  assert.equal(o!.amountBtc, "0.00100000");
});

test("findLoopOutgoingTransferOffer: never calls getActiveContracts without filter", async () => {
  const calls: unknown[] = [];
  const provider = {
    getActiveContracts: async (params?: { interfaceId?: string }) => {
      calls.push(params);
      return [
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: {
                contractId: "cid-1",
                interfaceViews: [
                  {
                    viewValue: {
                      transfer: {
                        sender: "user::1220",
                        receiver: "solver::1220",
                        amount: "0.001",
                        instrumentId: { id: "CBTC", admin: "cbtc-network::1220" }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      ];
    }
  };

  const cid = await findLoopOutgoingTransferOffer(provider, {
    senderParty: "user::1220",
    receiverParty: "solver::1220",
    amount: "0.001",
    instrumentId: { admin: "cbtc-network::1220", id: "CBTC" },
    amountDecimals: 8
  });

  assert.equal(cid, "cid-1");
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.ok(c && typeof c === "object");
    assert.ok(
      (c as { interfaceId?: string }).interfaceId?.includes("TransferInstruction")
    );
  }
});

test("normalizeLoopAcsResponse: unwraps contracts wrapper", () => {
  const items = [{ contract_id: "x" }];
  assert.deepEqual(normalizeLoopAcsResponse({ contracts: items }), items);
  assert.deepEqual(normalizeLoopAcsResponse(items), items);
  assert.deepEqual(normalizeLoopAcsResponse(null), []);
});
