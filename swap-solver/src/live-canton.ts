/**
 * Live Canton DevNet delivery leg (Task 10's remaining piece).
 *   node --import tsx src/live-canton.ts
 *
 * 1. Creates a cBTC transfer offer: warpx float -> RECIPIENT party (tiny amount).
 * 2. Polls until YOU accept the offer in the registry UI.
 * 3. Detects the accept via resolveOffer and prints the record-time.
 *
 * This is the FIRST live-ledger exercise of createOffer/resolveOffer, so expect
 * we may need to fix JSON-shape mismatches (like the getHoldings bug).
 */

import { CantonClient } from "./canton.js";

const DEVNET = {
  ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
  registryUrl: "https://api.utilities.digitalasset-dev.com",
  decentralizedPartyId:
    "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff",
  instrumentId: {
    admin: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff",
    id: "CBTC",
  },
};

const FLOAT_PARTY =
  "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const RECIPIENT =
  "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
const AMOUNT_BTC = "0.0001"; // tiny

function envReq(k: string, fallback?: string): string {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

async function main() {
  const client = new CantonClient(
    { ...DEVNET, solverParty: FLOAT_PARTY },
    {
      tokenUrl: envReq("KEYCLOAK_TOKEN_URL"),
      clientId: envReq("KEYCLOAK_CLIENT_ID"),
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ?? envReq("KEYCLOAK_CLIENT_SECRET"),
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api",
    },
  );

  // 0. confirm float
  const float = await client.getFloatSats();
  console.log(`float: ${Number(float) / 1e8} cBTC`);
  if (float === 0n) throw new Error("float is 0 — fund it first");

  // 1. create the offer
  console.log(`\ncreating offer: ${AMOUNT_BTC} cBTC  ${FLOAT_PARTY.slice(0, 24)}… -> ${RECIPIENT.slice(0, 24)}…`);
  const holdings = await client.getHoldings(FLOAT_PARTY);
  const { updateId, offerContractId } = await client.createOffer({
    receiverParty: RECIPIENT,
    amountBtc: AMOUNT_BTC,
    inputHoldings: holdings,
  });
  console.log(`✓ offer created`);
  console.log(`  updateId: ${updateId}`);
  console.log(`  offerId:  ${offerContractId}`);
  console.log(`\n>>> NOW ACCEPT THE OFFER in the registry UI as the recipient party. <<<`);
  console.log(`    (Transfers tab → accept the incoming CBTC transfer)\n`);

  // 2. poll for acceptance
  const fromOffset = 0;
  for (let i = 0; i < 120; i++) {
    const active = await client.isOfferActive(RECIPIENT, offerContractId).catch(() => true);
    if (!active) {
      const res = await client.resolveOffer({ receiverParty: RECIPIENT, offerContractId, fromOffset });
      if (res.kind === "accepted") {
        console.log(`\n✓ ACCEPTED at record-time ${res.recordTime} (updateId ${res.updateId})`);
        console.log(`\n✓ LIVE CANTON DELIVERY PASSED`);
        return;
      }
      if (res.kind === "expired") {
        console.log(`\n✗ offer was archived but NOT accepted (expired/cancelled): ${res.updateId}`);
        return;
      }
      // archived but resolution unknown yet — keep polling a couple times
    }
    process.stdout.write(`  waiting for accept… (${i * 5}s)\r`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`\n✗ timed out waiting for acceptance (10 min). Offer ${offerContractId} still pending.`);
}

main().catch((e) => {
  console.error("\n✗ live canton failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
