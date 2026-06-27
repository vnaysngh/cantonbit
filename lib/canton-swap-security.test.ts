import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildLoopFillResultFromEvents } from "./canton-swap-leg-verify-logic";
import { cantonSwapQuoteRateLimitOk, clientIpFromRequest } from "./canton-swap-rate-limit";

test("cantonSwapQuoteRateLimitOk enforces bucket", () => {
  const key = `test-${Date.now()}`;
  for (let i = 0; i < 30; i++) {
    assert.equal(cantonSwapQuoteRateLimitOk(key), true);
  }
  assert.equal(cantonSwapQuoteRateLimitOk(key), false);
});

test("clientIpFromRequest ignores spoofable x-real-ip", () => {
  const req = new Request("http://localhost/quote", {
    headers: {
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1, 10.0.0.1"
    }
  });
  assert.equal(clientIpFromRequest(req), "198.51.100.1");
});

test("clientIpFromRequest takes client before one trusted proxy hop", () => {
  const req = new Request("http://localhost/quote", {
    headers: { "x-forwarded-for": "evil, 9.9.9.9" }
  });
  assert.equal(clientIpFromRequest(req), "evil");
});

test("clientIpFromRequest returns null when x-forwarded-for is missing", () => {
  const req = new Request("http://localhost/quote");
  assert.equal(clientIpFromRequest(req), null);
});

test("clientIpFromRequest takes client before two trusted proxy hops", () => {
  const old = process.env.TRUSTED_PROXY_HOPS;
  process.env.TRUSTED_PROXY_HOPS = "2";
  try {
    const req = new Request("http://localhost/quote", {
      headers: {
        "x-forwarded-for": "203.0.113.1, 10.0.0.1, 10.0.0.2"
      }
    });
    assert.equal(clientIpFromRequest(req), "203.0.113.1");
  } finally {
    if (old === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = old;
  }
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

test("buildLoopFillResultFromEvents: direct transfer not pending accept when delivery proven", () => {
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
    {
      "0": {
        ExercisedTreeEvent: {
          value: {
            choice: "TransferPreapproval_SendV2",
            choiceArgument: {
              sender: "solver::1",
              amount: "10"
            },
            exerciseResult: {
              result: {
                summary: {
                  balanceChanges: [
                    ["solver::1", { changeToInitialAmountAsOfRoundZero: "-10" }],
                    ["user::1", { changeToInitialAmountAsOfRoundZero: "10" }]
                  ]
                }
              }
            }
          }
        }
      }
    },
    "direct",
    { admin: "dso::1", id: "Amulet" }
  );
  assert.equal(result.counterLegPendingAccept, false);
});

test("buildLoopFillResultFromEvents: direct kind without delivery proof throws", () => {
  const order = {
    id: "swap-1",
    solverParty: "solver::1",
    userParty: "user::1",
    toAsset: "CC" as const,
    outAmount: "10"
  };
  assert.throws(
    () =>
      buildLoopFillResultFromEvents(
        order as import("./canton-swap-types").CantonSwapOrder,
        "update-2",
        {},
        "direct"
      ),
    /did not deliver to user/
  );
});

test("buildLoopFillResultFromEvents: prefers pending offer when direct delivery not proven", () => {
  const order = {
    id: "swap-1",
    solverParty: "solver::1",
    userParty: "user::1",
    toAsset: "CC" as const,
    outAmount: "10"
  };
  const result = buildLoopFillResultFromEvents(
    order as import("./canton-swap-types").CantonSwapOrder,
    "update-3",
    {
      "0": {
        CreatedTreeEvent: {
          value: {
            contractId: "transient-counter-offer",
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
    "direct"
  );
  assert.equal(result.counterLegOfferCid, "transient-counter-offer");
  assert.equal(result.counterLegPendingAccept, true);
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
