/**
 * Read-only: check the cBTC float of a Canton party on DevNet.
 *   node --import tsx src/check-float.ts
 *
 * Uses the Oranj app's KEYCLOAK_* creds + the devnet constants. Prints the
 * party's spendable cBTC (satoshis + BTC). No writes.
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

function envReq(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (load the app's .env.local)`);
  return v;
}

async function main() {
  const party =
    process.env.SOLVER_CANTON_PARTY ??
    "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

  // Devnet Authentik creds. Prefer explicit CANTON_DEVNET_* names; fall back to
  // the pieces we already have (devnet client id + the *_DEVNET secret). The
  // token URL may differ from mainnet's — set CANTON_DEVNET_TOKEN_URL if so.
  const tokenUrl =
    process.env.CANTON_DEVNET_TOKEN_URL ?? envReq("KEYCLOAK_TOKEN_URL");
  const clientId =
    process.env.CANTON_DEVNET_CLIENT_ID ?? envReq("KEYCLOAK_CLIENT_ID");
  const clientSecret =
    process.env.CANTON_DEVNET_CLIENT_SECRET ??
    process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ??
    envReq("KEYCLOAK_CLIENT_SECRET");

  console.log(`auth: tokenUrl host=${new URL(tokenUrl).host} clientId.len=${clientId.length} secret.len=${clientSecret.length}\n`);

  const client = new CantonClient(
    { ...DEVNET, solverParty: party },
    { tokenUrl, clientId, clientSecret, scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api" },
  );

  console.log(`checking float for party:\n  ${party}\n`);
  const holdings = await client.getHoldings(party);
  const sats = await client.getFloatSats();
  console.log(`holdings: ${holdings.length}`);
  for (const h of holdings) console.log(`  ${h.amount} cBTC  (cid ${h.contractId.slice(0, 24)}…)`);
  console.log(`\nTOTAL FLOAT: ${sats} sats = ${Number(sats) / 1e8} cBTC`);
  if (sats === 0n) {
    console.log("\n⚠ float is 0 — this party can't deliver. Fund it before the live Canton run.");
  } else {
    console.log("\n✓ float available — enough for a tiny test delivery.");
  }
}

main().catch((e) => {
  console.error("float check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
