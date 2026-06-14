#!/usr/bin/env npx tsx
/** Diagnostic: which preapprovals block CC↔CBTC managed atomic swap. */
import { NETWORK } from "../lib/constants.js";

const solver =
  process.argv[2] ??
  "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const user =
  process.argv[3] ??
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

async function jwt() {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL!;
  const clientId =
    process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID!;
  const clientSecret =
    process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ||
    process.env.KEYCLOAK_CLIENT_SECRET!;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
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
  return ((await res.json()) as { access_token: string }).access_token;
}

async function ccPreapproval(j: string, party: string): Promise<boolean> {
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`,
    { headers: { Authorization: `Bearer ${j}` } }
  );
  if (r.status === 404 || !r.ok) return false;
  const body = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!body?.transfer_preapproval;
}

async function ccTransferKind(
  j: string,
  sender: string,
  receiver: string,
  amount: string
): Promise<string> {
  const dsoRes = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/dso-party-id`,
    { headers: { Authorization: `Bearer ${j}` } }
  );
  const dso = ((await dsoRes.json()) as { dso_party_id: string }).dso_party_id;
  const now = new Date().toISOString();
  const body = {
    choiceArguments: {
      expectedAdmin: dso,
      transfer: {
        sender,
        receiver,
        amount,
        instrumentId: { admin: dso, id: "Amulet" },
        lock: null,
        requestedAt: now,
        executeBefore: new Date(Date.now() + 600_000).toISOString(),
        inputHoldingCids: [],
        meta: { values: {} }
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  };
  const r = await fetch(
    `${NETWORK.validatorHost}/api/validator/v0/scan-proxy/registry/transfer-instruction/v1/transfer-factory`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${j}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const text = await r.text();
  if (!r.ok) return `ERROR ${r.status}: ${text.slice(0, 120)}`;
  return ((JSON.parse(text) as { transferKind?: string }).transferKind ??
    "?") as string;
}

async function cbtcTransferKind(
  sender: string,
  receiver: string,
  amount: string,
  inputHoldingCids: string[] = []
): Promise<string> {
  const admin = NETWORK.decentralizedPartyId;
  const now = new Date().toISOString();
  const body = {
    choiceArguments: {
      expectedAdmin: admin,
      transfer: {
        sender,
        receiver,
        amount,
        instrumentId: NETWORK.instrumentId,
        lock: null,
        requestedAt: now,
        executeBefore: new Date(Date.now() + 600_000).toISOString(),
        inputHoldingCids,
        meta: { values: {} }
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } }
    }
  };
  const r = await fetch(
    `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${admin}/registry/transfer-instruction/v1/transfer-factory`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  const text = await r.text();
  if (!r.ok) return `ERROR ${r.status}: ${text.slice(0, 120)}`;
  return ((JSON.parse(text) as { transferKind?: string }).transferKind ??
    "?") as string;
}

const j = await jwt();
console.log("=== CC→CBTC preapproval diagnostic ===\n");
console.log("Solver:", solver.slice(0, 40) + "…");
console.log("User:", user.slice(0, 40) + "…\n");

const solverCc = await ccPreapproval(j, solver);
const userCc = await ccPreapproval(j, user);
console.log("CC TransferPreapproval (Splice EnableCC):");
console.log("  solver:", solverCc ? "YES" : "NO");
console.log("  user:", userCc ? "YES" : "NO");

console.log("\nTransfer factory transferKind (empty holdings — kind only):");
const leg1 = await ccTransferKind(j, user, solver, "44");
const leg2 = await cbtcTransferKind(
  solver,
  user,
  "0.00010781",
  [
    "00f4f17da69a37658e026553cdc2daf0fa21c7171593b13021db8329ff139bf6d4ca121220a433765455d8dd4802e20c536e79b4261977fa2221ffa7f0af2c0b6230e0f693"
  ]
);
console.log("  Leg1 user→solver CC:", leg1);
console.log("  Leg2 solver→user CBTC:", leg2);

console.log("\nFor CC→CBTC managed atomic swap you need:");
console.log("  Leg1 direct → solver CC TransferPreapproval");
console.log("  Leg2 direct → user CBTC utility preapproval (Digital Asset Registry)");
console.log("\nYour screenshot CBTC preapproval on warpx-devnet-1 helps CBTC→CC, not CC→CBTC leg2.");
