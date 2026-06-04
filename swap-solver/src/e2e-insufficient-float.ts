/**
 * INSUFFICIENT-FLOAT E2E — the "refuse rather than half-deliver" guard, LIVE.
 *   node --env-file=../.env.local --env-file=.env --import tsx src/e2e-insufficient-float.ts
 *
 * Proves that when an order asks for MORE cBTC than the solver's float holds,
 * the solver REFUSES: marks the order `failed` and NEVER creates a Canton offer
 * (never spends/locks float). This is the guard in delivery.ts GUARD 2.
 *
 * It exercises the REAL code path — the real CantonClient.getFloatSats() against
 * DevNet + the real startDelivery() guard — with ZERO risk: by design it never
 * reaches createOffer, so no cBTC moves.
 *
 * Method: read the real current float, then synthesise a `seen` order whose
 * output amount is (float + a margin), and run startDelivery against it.
 *
 * Note on env: load .env.local FIRST then .env LAST so the 20-char DEVNET
 * client_id (in .env) wins over the app's 21-char client_id, paired with
 * KEYCLOAK_CLIENT_SECRET_DEVNET.
 */

import { pad, parseUnits, type Hex } from "viem";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { CantonClient } from "./canton.js";
import { OrderStore, type SerializedOrder } from "./store.js";
import { startDelivery } from "./delivery.js";
import { cantonPartyToRecipient } from "./order.js";

const DEVNET = {
  ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
  registryUrl: "https://api.utilities.digitalasset-dev.com",
  decentralizedPartyId: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff",
  instrumentId: { admin: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff", id: "CBTC" },
};
const FLOAT_PARTY = "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const RECIPIENT = "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const CBTC_DECIMALS = 8;

function env(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
const log = (s: string) => console.log(`\n=== ${s} ===`);

async function main() {
  const canton = new CantonClient(
    { ...DEVNET, solverParty: FLOAT_PARTY },
    { tokenUrl: env("KEYCLOAK_TOKEN_URL"), clientId: env("KEYCLOAK_CLIENT_ID"),
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ?? env("KEYCLOAK_CLIENT_SECRET"),
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api" },
  );

  log("0. Read the REAL current float (DevNet)");
  const floatSats = await canton.getFloatSats();
  console.log(`float: ${Number(floatSats) / 1e8} cBTC (${floatSats} sats)`);
  assert.ok(floatSats >= 0n, "float read failed");

  // Build an order asking for MORE than the float: float + 1 whole cBTC.
  const askSats = floatSats + parseUnits("1", CBTC_DECIMALS); // way over float
  log(`1. Synthesise a 'seen' order asking ${Number(askSats) / 1e8} cBTC (> float)`);

  const now = Math.floor(Date.now() / 1000);
  const orderId = pad("0xdeadbeef01", { size: 32 }) as Hex;
  const serialized: SerializedOrder = {
    user: "0x0B95ec21579aee6Ef7b712976bD86689D68b5A08",
    nonce: String(now),
    originChainId: "84532",
    expires: now + 6 * 3600,
    fillDeadline: now + 3 * 3600,
    inputOracle: env("ORACLE_ADDRESS") as Hex,
    inputs: [[String(BigInt(env("WBTC_ADDRESS"))), askSats.toString()]],
    outputs: [{
      oracle: pad(env("ORACLE_ADDRESS") as Hex, { size: 32 }),
      settler: pad("0xca470", { size: 32 }),
      chainId: "1000000000000001",
      token: pad("0xc87c", { size: 32 }),
      amount: askSats.toString(),
      recipient: cantonPartyToRecipient(RECIPIENT),
      callbackData: "0x",
      context: "0x",
    }],
  };

  const storePath = "/tmp/oranj-e2e-insufficient.json";
  rmSync(storePath, { force: true });
  const store = new OrderStore(storePath);
  store.insertSeen(orderId, 1, serialized);
  // Attach the (valid) party preimage so the guard reaches the FLOAT check,
  // not the party-mismatch check.
  store.update(orderId, { cantonParty: RECIPIENT });
  assert.equal(store.get(orderId)?.status, "seen", "setup: order should be seen");

  log("2. Run the REAL startDelivery guard");
  const outcome = await startDelivery(store, canton, orderId, {
    now, minSecondsBeforeDeadline: 30 * 60, cbtcDecimals: CBTC_DECIMALS,
  });
  console.log("outcome:", JSON.stringify(outcome));

  // === ASSERTIONS ===
  log("3. Verify the solver REFUSED and did not deliver");
  assert.equal(outcome.kind, "failed", `expected 'failed', got '${outcome.kind}'`);
  assert.ok(/insufficient cBTC float/i.test((outcome as { reason: string }).reason), `reason should mention insufficient float, got: ${(outcome as { reason: string }).reason}`);
  const rec = store.get(orderId)!;
  assert.equal(rec.status, "failed", `store status should be 'failed', got '${rec.status}'`);
  assert.ok(!rec.cantonDeliveryRef, "NO offer should have been created (cantonDeliveryRef must be empty)");
  console.log("solver refused ✓  status=failed ✓  no offer created ✓");

  // Float must be UNCHANGED — proves nothing was spent.
  log("4. Confirm float unchanged (nothing spent)");
  const floatAfter = await canton.getFloatSats();
  assert.equal(floatAfter, floatSats, `float changed! before=${floatSats} after=${floatAfter}`);
  console.log(`float still ${Number(floatAfter) / 1e8} cBTC ✓`);

  rmSync(storePath, { force: true });
  console.log(`\n\n========== ✓ INSUFFICIENT-FLOAT E2E PASSED ==========`);
  console.log(`  asked ${Number(askSats) / 1e8} cBTC vs ${Number(floatSats) / 1e8} float → refused, no delivery, float intact`);
  console.log(`=====================================================`);
}

main().catch((e) => { console.error("\n✗ INSUFFICIENT-FLOAT E2E FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
