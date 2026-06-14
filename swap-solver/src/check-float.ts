/**
 * Read-only: check the CBTC float of a Canton party.
 *   devnet : node --env-file=.env --env-file=../.env.local --import tsx src/check-float.ts
 *   mainnet: node --env-file=.env --env-file=../.env.local --env-file=.env.mainnet --import tsx src/check-float.ts
 *
 * NETWORK-AWARE: reads CANTON_* + SOLVER_CANTON_PARTY from env (so it matches
 * whatever env file you load — devnet or mainnet) and only falls back to devnet
 * constants if those are unset. No writes.
 */

import { CantonClient } from "./canton.js";

// Fallback DEVNET constants (used only if CANTON_* env vars are absent).
const DEVNET = {
  ledgerHost: "https://ledger-api.validator.devnet.warpx.fivenorth.io",
  registryUrl: "https://api.utilities.digitalasset-dev.com",
  admin:
    "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff",
  party:
    "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9"
};

function envReq(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (load the app's .env.local)`);
  return v;
}

async function main() {
  // Network-driven config — env wins so this never silently checks the wrong net.
  const isMainnet =
    (process.env.SWAP_NETWORK ?? "").toLowerCase() === "mainnet";
  const ledgerHost = process.env.CANTON_LEDGER_HOST ?? DEVNET.ledgerHost;
  const registryUrl = process.env.CANTON_REGISTRY_URL ?? DEVNET.registryUrl;
  const admin = process.env.CANTON_ADMIN_PARTY ?? DEVNET.admin;
  const party = process.env.SOLVER_CANTON_PARTY ?? DEVNET.party;
  console.log(
    `network: ${isMainnet ? "MAINNET" : "devnet/other"}  ledger=${new URL(ledgerHost).host}\n`
  );

  const tokenUrl = envReq("KEYCLOAK_TOKEN_URL");
  // Pair devnet id + secret — using KEYCLOAK_CLIENT_ID (often mainnet in
  // .env.local) with KEYCLOAK_CLIENT_SECRET_DEVNET yields invalid_grant.
  const clientId =
    !isMainnet && process.env.KEYCLOAK_CLIENT_ID_DEVNET
      ? process.env.KEYCLOAK_CLIENT_ID_DEVNET
      : envReq("KEYCLOAK_CLIENT_ID");
  const clientSecret =
    !isMainnet && process.env.KEYCLOAK_CLIENT_SECRET_DEVNET
      ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET
      : envReq("KEYCLOAK_CLIENT_SECRET");

  console.log(
    `auth: tokenUrl host=${new URL(tokenUrl).host} clientId.len=${clientId.length} secret.len=${clientSecret.length}\n`
  );

  const client = new CantonClient(
    {
      ledgerHost,
      registryUrl,
      decentralizedPartyId: admin,
      instrumentId: { admin, id: "CBTC" },
      solverParty: party
    },
    {
      tokenUrl,
      clientId,
      clientSecret,
      scope: process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api"
    }
  );

  console.log(`checking float for party:\n  ${party}\n`);
  const holdings = await client.getHoldings(party);
  const sats = await client.getFloatSats();
  console.log(`holdings: ${holdings.length}`);
  for (const h of holdings)
    console.log(`  ${h.amount} CBTC  (cid ${h.contractId.slice(0, 24)}…)`);
  console.log(`\nTOTAL FLOAT: ${sats} sats = ${Number(sats) / 1e8} CBTC`);
  if (sats === 0n) {
    console.log(
      "\n⚠ float is 0 — this party can't deliver. Fund it before the live Canton run."
    );
  } else {
    console.log("\n✓ float available — enough for a tiny test delivery.");
  }
}

main().catch((e) => {
  console.error("float check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
