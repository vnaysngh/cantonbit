import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cantonQuoteSanityUserMessage,
  formatCantonQuoteError
} from "./canton-quote-messages";

test("formatCantonQuoteError hides Tradecraft jargon", () => {
  const raw =
    "Tradecraft quote 0.05207292 deviates from reference 0.05423008 (>300bps)";
  const out = formatCantonQuoteError(raw);
  assert.ok(!out.includes("Tradecraft"));
  assert.ok(!out.includes("bps"));
  assert.ok(out.includes("try"));
});

test("formatCantonQuoteError passes through API user messages", () => {
  const msg = cantonQuoteSanityUserMessage("CC", "CBTC");
  assert.equal(formatCantonQuoteError(msg), msg);
});

test("cantonQuoteSanityUserMessage differs by direction", () => {
  const ccToCbtc = cantonQuoteSanityUserMessage("CC", "CBTC");
  const cbtcToCc = cantonQuoteSanityUserMessage("CBTC", "CC");
  assert.ok(ccToCbtc.includes("CC"));
  assert.ok(cbtcToCc.includes("CBTC"));
  assert.notEqual(ccToCbtc, cbtcToCc);
});
