#!/usr/bin/env npx tsx
/**
 * Create CBTC utility TransferPreapproval for a hosted Canton party — no browser session.
 *
 * Usage:
 *   npm run enable-cbtc:devnet -- <party-id>
 *   PARTY_ID=party-… npm run enable-cbtc:devnet
 */
import { randomUUID } from "node:crypto";

import { NETWORK } from "../lib/constants";

const party = process.argv[2]?.trim() || process.env.PARTY_ID?.trim();
if (!party) {
  console.error("Usage: enable-cbtc-party.mts <party-id>");
  console.error("   or: PARTY_ID=party-… npm run enable-cbtc:devnet");
  process.exit(1);
}

const TRANSFER_PREAPPROVAL_TEMPLATE =
  "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";

let cachedOperator: string | null = null;

async function getLedgerJwt(): Promise<string> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const scope = process.env.KEYCLOAK_SCOPE ?? "daml_ledger_api";
  const isDevnet = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase() === "devnet";
  const clientId = isDevnet
    ? process.env.KEYCLOAK_CLIENT_ID_DEVNET || process.env.KEYCLOAK_CLIENT_ID
    : process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = isDevnet
    ? process.env.KEYCLOAK_CLIENT_SECRET_DEVNET || process.env.KEYCLOAK_CLIENT_SECRET
    : process.env.KEYCLOAK_CLIENT_SECRET;
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Missing KEYCLOAK_* env vars for ledger JWT");
  }
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
  if (!res.ok) {
    throw new Error(`JWT fetch failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

async function getLedgerEnd(jwt: string): Promise<string> {
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!r.ok) {
    throw new Error(`ledger-end failed (${r.status}): ${await r.text()}`);
  }
  const j = (await r.json()) as { offset?: string };
  if (!j.offset) throw new Error("ledger-end returned no offset");
  return j.offset;
}

async function fetchUtilityOperator(): Promise<string> {
  if (cachedOperator) return cachedOperator;
  const r = await fetch(`${NETWORK.registryUrl}/api/utilities/v0/operator`, {
    cache: "no-store"
  });
  if (!r.ok) {
    throw new Error(
      `Utility operator lookup failed (${r.status}): ${await r.text().catch(() => "")}`
    );
  }
  const j = (await r.json()) as { partyId?: string };
  const op = j.partyId?.trim();
  if (!op) throw new Error("Utility operator lookup returned no partyId");
  cachedOperator = op;
  return op;
}

async function hasCbtcPreapproval(jwt: string, receiverParty: string): Promise<boolean> {
  const activeAtOffset = await getLedgerEnd(jwt);
  const r = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    cache: "no-store",
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [receiverParty]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: TRANSFER_PREAPPROVAL_TEMPLATE,
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
      activeAtOffset
    })
  });
  if (!r.ok) return false;
  const entries = (await r.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent?: {
          createArgument?: {
            receiver?: string;
            instrumentAdmin?: string;
          };
        };
      };
    };
  }>;
  const admin = NETWORK.decentralizedPartyId;
  for (const e of entries) {
    const arg = e.contractEntry?.JsActiveContract?.createdEvent?.createArgument;
    if (arg?.receiver === receiverParty && arg?.instrumentAdmin === admin) {
      return true;
    }
  }
  return false;
}

async function enableCbtcPreapprovalForParty(
  jwt: string,
  receiverParty: string
): Promise<void> {
  const operator = await fetchUtilityOperator();
  const instrumentAdmin = NETWORK.decentralizedPartyId;

  const res = await fetch(
    `${NETWORK.ledgerHost}/v2/commands/submit-and-wait-for-transaction-tree`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      cache: "no-store",
      body: JSON.stringify({
        applicationId: "cbtc-app",
        commandId: randomUUID(),
        workflowId: `enable-cbtc-${randomUUID()}`,
        actAs: [receiverParty],
        readAs: [receiverParty],
        commands: [
          {
            CreateCommand: {
              templateId: TRANSFER_PREAPPROVAL_TEMPLATE,
              createArguments: {
                operator,
                receiver: receiverParty,
                instrumentAdmin,
                instrumentAllowances: []
              }
            }
          }
        ]
      })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    if (/already|duplicate|exists/i.test(text)) return;
    throw new Error(`Enable CBTC preapproval failed (${res.status}): ${text}`);
  }

  for (let i = 0; i < 10; i++) {
    if (await hasCbtcPreapproval(jwt, receiverParty)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

console.log(`=== Enable CBTC (${NETWORK.name}) ===\n`);
console.log(`Party: ${party.slice(0, 40)}…\n`);
console.log(`Instrument admin: ${NETWORK.decentralizedPartyId.slice(0, 40)}…\n`);

const jwt = await getLedgerJwt();
const before = await hasCbtcPreapproval(jwt, party);
console.log("Before:", { cbtcEnabled: before });

if (!before) {
  console.log("\nCreating utility TransferPreapproval…");
  await enableCbtcPreapprovalForParty(jwt, party);
}

const after = await hasCbtcPreapproval(jwt, party);
console.log("\nAfter:", { cbtcEnabled: after });

if (!after) {
  console.error("\nEnable CBTC finished but preapproval not visible yet.");
  process.exit(1);
}

console.log("\n✓ Enable CBTC complete.");
