#!/usr/bin/env npx tsx
/** Print CC (Amulet) instrument admin = DSO party id per network. */
import { NETWORKS, type NetworkName } from "../lib/constants.js";

async function jwtFor(network: NetworkName): Promise<string> {
  process.env.NEXT_PUBLIC_NETWORK = network;
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL!;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  const isDevnet = network === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID!
    : process.env.KEYCLOAK_CLIENT_ID!;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ||
      process.env.KEYCLOAK_CLIENT_SECRET!
    : process.env.KEYCLOAK_CLIENT_SECRET!;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope
    })
  });
  if (!res.ok) throw new Error(`JWT ${network} (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function fetchDso(network: NetworkName) {
  const cfg = NETWORKS[network];
  const j = await jwtFor(network);
  const r = await fetch(
    `${cfg.validatorHost}/api/validator/v0/scan-proxy/dso-party-id`,
    { headers: { Authorization: `Bearer ${j}` } }
  );
  const text = await r.text();
  if (!r.ok) return { network, error: `${r.status}: ${text.slice(0, 120)}` };
  const dso = (JSON.parse(text) as { dso_party_id?: string }).dso_party_id;
  return {
    network,
    dso,
    instrumentId: { admin: dso, id: "Amulet" },
    ccRegistryUrl: cfg.ccRegistryUrl,
    validatorHost: cfg.validatorHost
  };
}

const target = (process.argv[2] as NetworkName | undefined) ?? "all";
const nets: NetworkName[] =
  target === "all" ? ["devnet", "mainnet"] : [target];

for (const n of nets) {
  console.log(`\n=== ${n} ===`);
  try {
    const out = await fetchDso(n);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log("error:", e instanceof Error ? e.message : e);
  }
}
