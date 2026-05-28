/**
 * Unit tests for the money-critical mint-processor decision logic.
 *
 * Run with:  npx tsx --test lib/mint-processor-logic.test.ts
 *
 * No DB / network — pure logic only. These guard the invariants that, when
 * violated in production, caused duplicate offers and stranded mints.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decideMintAction,
  extractCreatedOfferCid,
} from "./mint-processor-logic";

// ─────────────────────────────────────────────────────────────────────────
// extractCreatedOfferCid — pulls the offer CID out of a transaction tree
// ─────────────────────────────────────────────────────────────────────────

test("extractCreatedOfferCid: finds TransferInstruction in CreatedTreeEvent", () => {
  const tree = {
    "0": {
      ExercisedTreeEvent: { value: { contractId: "factory-cid", choice: "TransferFactory_Transfer" } },
    },
    "1": {
      CreatedTreeEvent: {
        value: {
          contractId: "offer-cid-123",
          templateId: "abc:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        },
      },
    },
  };
  assert.equal(extractCreatedOfferCid(tree), "offer-cid-123");
});

test("extractCreatedOfferCid: finds TransferOffer template", () => {
  const tree = {
    "0": {
      CreatedTreeEvent: {
        value: {
          contractId: "offer-cid-456",
          templateId: "xyz:Utility.Registry.App.V0.Model.Transfer:TransferOffer",
        },
      },
    },
  };
  assert.equal(extractCreatedOfferCid(tree), "offer-cid-456");
});

test("extractCreatedOfferCid: tolerates flat CreatedEvent shape", () => {
  const tree = {
    "2": {
      CreatedEvent: {
        contractId: "offer-cid-789",
        templateId: "p:M:TransferInstruction",
      },
    },
  };
  assert.equal(extractCreatedOfferCid(tree), "offer-cid-789");
});

test("extractCreatedOfferCid: ignores non-offer created contracts (e.g. Holding)", () => {
  const tree = {
    "0": {
      CreatedTreeEvent: {
        value: { contractId: "holding-cid", templateId: "p:Utility.Registry.Holding.V0.Holding:Holding" },
      },
    },
  };
  assert.equal(extractCreatedOfferCid(tree), null);
});

test("extractCreatedOfferCid: null/undefined/empty are safe", () => {
  assert.equal(extractCreatedOfferCid(undefined), null);
  assert.equal(extractCreatedOfferCid(null), null);
  assert.equal(extractCreatedOfferCid({}), null);
});

// ─────────────────────────────────────────────────────────────────────────
// decideMintAction — the duplicate-offer guard
// ─────────────────────────────────────────────────────────────────────────

test("decideMintAction: fresh mint with no row → create", () => {
  assert.equal(decideMintAction(null), "create");
});

test("decideMintAction: pending row, no offer yet → create", () => {
  assert.equal(decideMintAction({ status: "pending", offerContractId: null }), "create");
});

test("decideMintAction: offer already recorded → accept-existing (NEVER recreate)", () => {
  // THIS is the regression guard for the duplicate-offer incident.
  assert.equal(
    decideMintAction({ status: "failed", offerContractId: "offer-cid-abc" }),
    "accept-existing",
  );
  assert.equal(
    decideMintAction({ status: "offer_created", offerContractId: "offer-cid-abc" }),
    "accept-existing",
  );
});

test("decideMintAction: already transferred → skip", () => {
  assert.equal(decideMintAction({ status: "transferred", offerContractId: "x" }), "skip");
});

test("decideMintAction: processing (owned by another worker) → skip", () => {
  assert.equal(decideMintAction({ status: "processing", offerContractId: null }), "skip");
});

test("decideMintAction: transferred takes priority even with offer set", () => {
  assert.equal(decideMintAction({ status: "transferred", offerContractId: "x" }), "skip");
});
