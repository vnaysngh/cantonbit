import assert from "node:assert/strict";
import { test } from "node:test";

import { readTransferInstructionPayload } from "./transfer-instruction-read";

test("readTransferInstructionPayload: nested interface view transfer", () => {
  const payload = readTransferInstructionPayload({
    contractId: "cid-1",
    templateId: "tpl",
    interfaceViews: [
      {
        interfaceId:
          "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        viewValue: {
          transfer: {
            sender: "user::1",
            receiver: "solver::1",
            amount: "0.001",
            instrumentId: { admin: "cbtc-network::1220", id: "CBTC" }
          }
        }
      }
    ]
  });
  assert.ok(payload);
  assert.equal(payload!.sender, "user::1");
  assert.equal(payload!.receiver, "solver::1");
  assert.equal(payload!.amount, "0.001");
});

test("readTransferInstructionPayload: flat interface view", () => {
  const payload = readTransferInstructionPayload({
    contractId: "cid-2",
    templateId: "tpl",
    interfaceViews: [
      {
        interfaceId:
          "abc123:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        viewValue: {
          sender: "user::2",
          receiver: "solver::2",
          amount: "1.5",
          instrumentId: { admin: "DSO::1", id: "Amulet" }
        }
      }
    ]
  });
  assert.ok(payload);
  assert.equal(payload!.receiver, "solver::2");
});

test("readTransferInstructionPayload: createArgument.transfer fallback", () => {
  const payload = readTransferInstructionPayload({
    contractId: "cid-3",
    templateId: "tpl",
    createArgument: {
      transfer: {
        sender: "user::3",
        receiver: "solver::3",
        amount: "2",
        instrumentId: { admin: "a", id: "CBTC" }
      }
    }
  });
  assert.ok(payload);
  assert.equal(payload!.amount, "2");
});
