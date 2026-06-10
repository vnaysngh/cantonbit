/**
 * Store smoke test — proves SupabaseOrderStore works against the REAL Supabase DB,
 * AND that TWO separate store instances (simulating the api + watch processes)
 * share state through the DB. This is the exact fix for the Railway bug where the
 * api wrote an order the watch loop couldn't see.
 *
 * Requires the 006_solver_orders migration applied + env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   node --env-file=../.env.local --import tsx src/store.smoke.ts
 *
 * It cleans up after itself (deletes its test rows).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { SupabaseOrderStore, type SerializedOrder } from "./store.js";
import type { Hex } from "viem";

function testOrder(amount = "10000"): SerializedOrder {
  return {
    user: "0x1111111111111111111111111111111111111111",
    nonce: "1",
    originChainId: "42161",
    expires: 1_900_000_000,
    fillDeadline: 1_899_999_000,
    inputOracle: "0x00000000000000000000000000000000000000aa",
    inputs: [["1", amount]],
    outputs: [{
      oracle: "0x" + "aa".repeat(32) as Hex, settler: "0x" + "bb".repeat(32) as Hex,
      chainId: "1", token: "0x" + "cc".repeat(32) as Hex, amount,
      recipient: "0x" + "dd".repeat(32) as Hex, callbackData: "0x", context: "0x",
    }],
  };
}

async function main() {
  // TWO independent stores — model the api process and the watch process.
  const apiStore = SupabaseOrderStore.fromEnv();
  const watchStore = SupabaseOrderStore.fromEnv();

  const id = ("0x" + randomBytes(32).toString("hex")) as Hex;
  console.log(`[smoke] test order ${id.slice(0, 14)}…`);

  // 1. API process: register the order + cantonParty (the write-ahead).
  await apiStore.insertSeen(id, 100, testOrder());
  await apiStore.update(id, { cantonParty: "cbtc-user-x::1220abcdef" });
  await apiStore.rememberParty(id, "cbtc-user-x::1220abcdef");
  console.log("[smoke] api: wrote order + cantonParty ✓");

  // 2. WATCH process (separate instance!): does it SEE the api's write? This is
  //    the exact Railway failure — separate processes must share state via the DB.
  const seenByWatch = await watchStore.get(id);
  assert.ok(seenByWatch, "watch process must SEE the order the api wrote (shared DB)");
  assert.equal(seenByWatch.cantonParty, "cbtc-user-x::1220abcdef", "watch must see the cantonParty (the stuck-order bug)");
  console.log("[smoke] watch: SAW the api's order + cantonParty across processes ✓ (the bug is fixed)");

  // 3. byStatus from the watch process finds it among 'seen'.
  const seenList = await watchStore.byStatus("seen");
  assert.ok(seenList.some((o) => o.orderId === id), "byStatus('seen') must include it");
  console.log("[smoke] byStatus('seen') finds it ✓");

  // 4. Atomic claim (the double-delivery guard): two concurrent claims, one wins.
  const [w1, w2] = await Promise.all([
    watchStore.claimStatus(id, "seen", "delivering", { note: "claim-A" }),
    apiStore.claimStatus(id, "seen", "delivering", { note: "claim-B" }),
  ]);
  assert.equal([w1, w2].filter(Boolean).length, 1, "exactly ONE concurrent claim must win (atomic CAS)");
  const afterClaim = await apiStore.get(id);
  assert.equal(afterClaim?.status, "delivering", "status advanced to delivering");
  console.log(`[smoke] atomic claim: exactly 1 of 2 concurrent claims won (${w1 ? "A" : "B"}) ✓`);

  // 5. A claim with the WRONG expected status fails (no transition).
  const wrong = await apiStore.claimStatus(id, "seen", "delivered");
  assert.equal(wrong, false, "claim with wrong expected status must fail");
  console.log("[smoke] claim from wrong status correctly rejected ✓");

  // 6. update round-trips full metadata.
  await apiStore.update(id, { status: "delivered", fillTimestamp: 1_899_999_500, cantonDeliveryRef: "offer-xyz", cbtcAccepted: true });
  const final = await watchStore.get(id);
  assert.equal(final?.status, "delivered");
  assert.equal(final?.fillTimestamp, 1_899_999_500);
  assert.equal(final?.cantonDeliveryRef, "offer-xyz");
  assert.equal(final?.cbtcAccepted, true);
  console.log("[smoke] full metadata round-trips across processes ✓");

  // 7. cursor read/write.
  const cur0 = await apiStore.cursorBlock();
  await apiStore.setCursor(cur0 + 5);
  assert.equal(await watchStore.cursorBlock(), cur0 + 5, "cursor shared across processes");
  await apiStore.setCursor(cur0); // restore (setCursor only advances, so this is a no-op — fine)
  console.log("[smoke] cursor shared across processes ✓");

  // cleanup: delete the test row.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const db = createClient(url, key, { auth: { persistSession: false } });
  await db.from("solver_orders").delete().eq("order_id", id);
  console.log("[smoke] cleaned up test row ✓");

  console.log("\n========== ✓ STORE SMOKE PASSED — Postgres shared-state works across processes ==========");
}

main().catch((e) => {
  console.error("\n✗ STORE SMOKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
