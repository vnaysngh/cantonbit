import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildLoopFillResultFromEvents } from "./canton-swap-leg-verify-logic";
import { cantonSwapQuoteRateLimitOk } from "./canton-swap-rate-limit";

test("cantonSwapQuoteRateLimitOk enforces bucket", () => {
  const key = `test-${Date.now()}`;
  for (let i = 0; i < 30; i++) {
    assert.equal(cantonSwapQuoteRateLimitOk(key), true);
  }
  assert.equal(cantonSwapQuoteRateLimitOk(key), false);
});

test("buildLoopFillResultFromEvents: pending accept when counter offer created", () => {
  const order = {
    id: "swap-1",
    solverParty: "solver::1",
    userParty: "user::1",
    toAsset: "CC" as const,
    outAmount: "10"
  };
  const result = buildLoopFillResultFromEvents(
    order as import("./canton-swap-types").CantonSwapOrder,
    "update-1",
    {
      "0": {
        CreatedTreeEvent: {
          value: {
            contractId: "counter-1",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId:
                  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
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
    "offer"
  );
  assert.equal(result.updateId, "update-1");
  assert.equal(result.counterLegOfferCid, "counter-1");
  assert.equal(result.counterLegPendingAccept, true);
});

test("buildLoopFillResultFromEvents: counter sender uses settlement vault", () => {
  const order = {
    id: "swap-1",
    solverParty: "warpx::1",
    settlementParty: "vault::1",
    userParty: "user::1",
    toAsset: "CC" as const,
    outAmount: "10"
  };
  const result = buildLoopFillResultFromEvents(
    order as import("./canton-swap-types").CantonSwapOrder,
    "update-1",
    {
      "0": {
        CreatedTreeEvent: {
          value: {
            contractId: "counter-1",
            templateId: "pkg:TransferInstruction",
            interfaceViews: [
              {
                interfaceId:
                  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                viewValue: {
                  transfer: {
                    sender: "vault::1",
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
    "offer"
  );
  assert.equal(result.counterLegOfferCid, "counter-1");
});

test("buildLoopFillResultFromEvents: direct transfer not pending accept", () => {
  const order = {
    id: "swap-1",
    solverParty: "solver::1",
    userParty: "user::1",
    toAsset: "CC" as const,
    outAmount: "10"
  };
  const result = buildLoopFillResultFromEvents(
    order as import("./canton-swap-types").CantonSwapOrder,
    "update-2",
    {},
    "direct"
  );
  assert.equal(result.counterLegPendingAccept, false);
});

test("migration 014 includes filling status in CHECK constraint", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/014_canton_swap_orders_status_check.sql"),
    "utf8"
  );
  assert.match(sql, /'filling'/);
});

test("migration 017 adds settlement_party column", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/017_canton_swap_settlement_party.sql"),
    "utf8"
  );
  assert.match(sql, /settlement_party/);
});
