import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAmuletPriceFromMiningRounds,
  parseAmuletRulesPayload,
  parseExtraTrafficPriceFromPayload
} from "./canton-scan-pricing";

test("parseExtraTrafficPriceFromPayload reads WarpX configSchedule shape", () => {
  const payload = {
    configSchedule: {
      initialValue: {
        decentralizedSynchronizer: {
          fees: { extraTrafficPrice: "60.0" }
        }
      }
    }
  };
  assert.equal(parseExtraTrafficPriceFromPayload(payload), 60);
});

test("parseExtraTrafficPriceFromPayload reads flat fees shape", () => {
  assert.equal(
    parseExtraTrafficPriceFromPayload({ fees: { extra_traffic_price: "42.5" } }),
    42.5
  );
});

test("parseAmuletRulesPayload accepts amulet_rules wrapper", () => {
  const payload = { configSchedule: { initialValue: { fees: { extraTrafficPrice: "1" } } } };
  assert.deepEqual(parseAmuletRulesPayload({ amulet_rules: { contract: { payload } } }), payload);
});

test("parseAmuletPriceFromMiningRounds reads amuletPrice", () => {
  assert.equal(
    parseAmuletPriceFromMiningRounds({
      open_mining_rounds: [{ contract: { payload: { amuletPrice: "0.05" } } }]
    }),
    0.05
  );
});

test("parseAmuletPriceFromMiningRounds picks latest round number", () => {
  assert.equal(
    parseAmuletPriceFromMiningRounds({
      open_mining_rounds: [
        {
          contract: {
            payload: { round: { number: "10" }, amuletPrice: "0.04" }
          }
        },
        {
          contract: {
            payload: { round: { number: "12" }, amuletPrice: "0.06" }
          }
        }
      ]
    }),
    0.06
  );
});
