#!/usr/bin/env npx tsx
/**
 * C2C preapproval/direct-delivery diagnostic.
 *
 * The settlement vault must stay preapproval-free so the user sell leg creates a
 * pending offer. User receive parties should have preapproval for the counter
 * asset so the vault can direct-deliver inside the same fill transaction.
 *
 * Usage:
 *   npm run check-swap-preapprovals:devnet -- <vault-party> <user-party>
 *   CANTON_SWAP_SETTLEMENT_PARTY=... PARTY_ID=... npm run check-swap-preapprovals:devnet
 *
 * Optional transfer-kind probes:
 *   CBTC_USER_HOLDING_CID=...   # for user→vault CBTC sell-leg kind
 *   CBTC_VAULT_HOLDING_CID=...  # for vault→user CBTC counter-leg kind
 */
import { NETWORK } from "../lib/constants.js";

type Check = {
  label: string;
  ok: boolean | "warn";
  detail: string;
};

const vault =
  process.argv[2]?.trim() ||
  process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY?.trim() ||
  process.env.SOLVER_CANTON_PARTY?.trim() ||
  process.env.NEXT_PUBLIC_SOLVER_CANTON?.trim() ||
  "";

const user =
  process.argv[3]?.trim() ||
  process.env.PARTY_ID?.trim() ||
  process.env.USER_PARTY?.trim() ||
  process.env.SWAP_TEST_USER_PARTY?.trim() ||
  "";

if (!vault || !user) {
  console.error(
    "Usage: check-swap-preapprovals.mts <settlement-vault-party> <user-party>\n" +
      "   or set CANTON_SWAP_SETTLEMENT_PARTY and PARTY_ID/SWAP_TEST_USER_PARTY"
  );
  process.exit(1);
}

function short(party: string): string {
  return party.length > 42 ? `${party.slice(0, 38)}…` : party;
}

function authEnv() {
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET ||
      process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env vars");
  }
  return { tokenUrl, clientId, clientSecret, scope };
}

async function jwt(): Promise<string> {
  const auth = authEnv();
  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: auth.scope
    })
  });
  if (!res.ok) throw new Error(`JWT fetch failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function validatorUrl(path: string): string {
  return `${NETWORK.validatorHost}/api/validator${path}`;
}

async function ccPreapproval(j: string, party: string): Promise<boolean | "unknown"> {
  const r = await fetch(
    validatorUrl(
      `/v0/scan-proxy/transfer-preapprovals/by-party/${encodeURIComponent(party)}`
    ),
    { headers: { Authorization: `Bearer ${j}` }, cache: "no-store" }
  );
  if (r.status === 404) return false;
  if (!r.ok) return "unknown";
  const body = (await r.json().catch(() => null)) as {
    transfer_preapproval?: unknown;
  } | null;
  return !!body?.transfer_preapproval;
}

async function ledgerEnd(j: string): Promise<number | null> {
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${j}` },
    cache: "no-store"
  });
  if (!r.ok) return null;
  const body = (await r.json().catch(() => null)) as { offset?: number } | null;
  return typeof body?.offset === "number" ? body.offset : null;
}

async function cbtcPreapproval(
  j: string,
  party: string
): Promise<boolean | "unknown"> {
  const offset = await ledgerEnd(j);
  if (offset == null) return "unknown";
  const template =
    "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${j}`
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: template,
                      includeCreatedEventBlob: false
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: true,
      activeAtOffset: offset
    })
  });
  if (!r.ok) return "unknown";
  const entries = (await r.json().catch(() => [])) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          createArgument?: { receiver?: string; instrumentAdmin?: string };
        };
      };
    };
  }>;
  const admin = NETWORK.decentralizedPartyId;
  return entries.some((e) => {
    const arg = e.contractEntry?.JsActiveContract?.createdEvent?.createArgument;
    return arg?.receiver === party && arg?.instrumentAdmin === admin;
  });
}

async function dsoParty(j: string): Promise<string> {
  const r = await fetch(validatorUrl("/v0/scan-proxy/dso-party-id"), {
    headers: { Authorization: `Bearer ${j}` },
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`DSO party lookup failed (${r.status}): ${await r.text()}`);
  return ((await r.json()) as { dso_party_id: string }).dso_party_id;
}

async function ccTransferKind(
  j: string,
  sender: string,
  receiver: string,
  amount: string
): Promise<string> {
  const dso = await dsoParty(j);
  const now = new Date().toISOString();
  const r = await fetch(
    validatorUrl("/v0/scan-proxy/registry/transfer-instruction/v1/transfer-factory"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${j}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
      })
    }
  );
  const text = await r.text();
  if (!r.ok) return `ERROR ${r.status}: ${text.slice(0, 160)}`;
  return ((JSON.parse(text) as { transferKind?: string }).transferKind ?? "?");
}

async function cbtcTransferKind(params: {
  sender: string;
  receiver: string;
  amount: string;
  inputHoldingCids: string[];
}): Promise<string> {
  const admin = NETWORK.decentralizedPartyId;
  const now = new Date().toISOString();
  const r = await fetch(
    `${NETWORK.registryUrl}/api/token-standard/v0/registrars/${admin}/registry/transfer-instruction/v1/transfer-factory`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: admin,
          transfer: {
            sender: params.sender,
            receiver: params.receiver,
            amount: params.amount,
            instrumentId: NETWORK.instrumentId,
            lock: null,
            requestedAt: now,
            executeBefore: new Date(Date.now() + 600_000).toISOString(),
            inputHoldingCids: params.inputHoldingCids,
            meta: { values: {} }
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } }
        }
      })
    }
  );
  const text = await r.text();
  if (!r.ok) return `ERROR ${r.status}: ${text.slice(0, 160)}`;
  return ((JSON.parse(text) as { transferKind?: string }).transferKind ?? "?");
}

function formatPre(v: boolean | "unknown"): string {
  if (v === "unknown") return "UNKNOWN";
  return v ? "YES" : "NO";
}

function isDirect(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "direct" || k === "self" || k.includes("direct");
}

function isOffer(kind: string): boolean {
  return !kind.startsWith("ERROR") && !isDirect(kind);
}

function printCheck(c: Check): void {
  const prefix = c.ok === true ? "PASS" : c.ok === "warn" ? "WARN" : "FAIL";
  console.log(`${prefix.padEnd(4)} ${c.label}: ${c.detail}`);
}

const j = await jwt();

console.log("=== C2C preapproval / direct-delivery diagnostic ===\n");
console.log(`Network: ${NETWORK.name}`);
console.log(`Vault:   ${short(vault)}`);
console.log(`User:    ${short(user)}\n`);

const [vaultCc, vaultCbtc, userCc, userCbtc] = await Promise.all([
  ccPreapproval(j, vault),
  cbtcPreapproval(j, vault),
  ccPreapproval(j, user),
  cbtcPreapproval(j, user)
]);

console.log("Preapproval posture:");
console.log(`  Vault CC:    ${formatPre(vaultCc)}  expected OFF`);
console.log(`  Vault CBTC:  ${formatPre(vaultCbtc)}  expected OFF`);
console.log(`  User CC:     ${formatPre(userCc)}  expected ON for CBTC→CC receives`);
console.log(`  User CBTC:   ${formatPre(userCbtc)}  expected ON for CC→CBTC receives\n`);

const checks: Check[] = [
  {
    label: "vault CC preapproval",
    ok: vaultCc === "unknown" ? "warn" : !vaultCc,
    detail:
      vaultCc === "unknown"
        ? "could not verify; must be OFF"
        : vaultCc
          ? "ON breaks pending user sell offers"
          : "OFF, user CC sell leg will stay offer-path"
  },
  {
    label: "vault CBTC preapproval",
    ok: vaultCbtc === "unknown" ? "warn" : !vaultCbtc,
    detail:
      vaultCbtc === "unknown"
        ? "could not verify; must be OFF"
        : vaultCbtc
          ? "ON breaks pending user sell offers"
          : "OFF, user CBTC sell leg will stay offer-path"
  },
  {
    label: "user CC receive preapproval",
    ok: userCc === "unknown" ? "warn" : !!userCc,
    detail:
      userCc === "unknown"
        ? "could not verify; CBTC→CC may require pending counter accept"
        : userCc
          ? "ON, CBTC→CC counter leg can direct-deliver"
          : "OFF, CBTC→CC counter leg will require user accept"
  },
  {
    label: "user CBTC receive preapproval",
    ok: userCbtc === "unknown" ? "warn" : !!userCbtc,
    detail:
      userCbtc === "unknown"
        ? "could not verify from this participant; use transferKind probe or Loop UI"
        : userCbtc
          ? "ON, CC→CBTC counter leg can direct-deliver"
          : "OFF, CC→CBTC counter leg will require user accept"
  }
];

for (const c of checks) printCheck(c);

console.log("\nTransferKind probes:");
const ccSellKind = await ccTransferKind(j, user, vault, "1");
const ccCounterKind = await ccTransferKind(j, vault, user, "1");
console.log(
  `${isOffer(ccSellKind) ? "PASS" : "FAIL"} CC user→vault sell: ${ccSellKind} expected offer`
);
console.log(
  `${isDirect(ccCounterKind) ? "PASS" : "WARN"} CC vault→user counter: ${ccCounterKind} expected direct`
);

const userCbtcHolding = process.env.CBTC_USER_HOLDING_CID?.trim();
const vaultCbtcHolding = process.env.CBTC_VAULT_HOLDING_CID?.trim();
if (userCbtcHolding) {
  const cbtcSellKind = await cbtcTransferKind({
    sender: user,
    receiver: vault,
    amount: "0.0001",
    inputHoldingCids: [userCbtcHolding]
  });
  console.log(
    `${isOffer(cbtcSellKind) ? "PASS" : "FAIL"} CBTC user→vault sell: ${cbtcSellKind} expected offer`
  );
} else {
  console.log(
    "SKIP CBTC user→vault sell transferKind: set CBTC_USER_HOLDING_CID to probe"
  );
}
if (vaultCbtcHolding) {
  const cbtcCounterKind = await cbtcTransferKind({
    sender: vault,
    receiver: user,
    amount: "0.0001",
    inputHoldingCids: [vaultCbtcHolding]
  });
  console.log(
    `${isDirect(cbtcCounterKind) ? "PASS" : "WARN"} CBTC vault→user counter: ${cbtcCounterKind} expected direct`
  );
} else {
  console.log(
    "SKIP CBTC vault→user counter transferKind: set CBTC_VAULT_HOLDING_CID to probe"
  );
}

const hardFail = checks.some((c) => c.ok === false) || !isOffer(ccSellKind);
if (hardFail) {
  console.error(
    "\nC2C preapproval posture is not safe for atomic offer/fill settlement."
  );
  process.exit(1);
}

console.log(
  "\nSafe posture: vault preapproval OFF. Direct counter delivery depends on user receive preapprovals."
);
