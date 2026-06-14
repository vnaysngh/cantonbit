/**
 * CBTC utility-registry TransferPreapproval for hosted parties.
 * Enables direct (auto-accept) incoming CBTC — required for CC→CBTC atomic swaps.
 *
 * @see https://docs.digitalasset.com/utilities/devnet/how-tos/registry/transfer-preapproval/transfer-preapproval.html
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { getLedgerJwt } from "./auth";
import { getLedgerEnd } from "./canton";
import { NETWORK } from "./constants";

const TAG = "[enable-cbtc]";
const TRANSFER_PREAPPROVAL_TEMPLATE =
  "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";

let cachedOperator: string | null = null;

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

/** True when party has active CBTC utility TransferPreapproval for this network's registrar. */
export async function hasCbtcPreapproval(receiverParty: string): Promise<boolean> {
  const jwt = await getLedgerJwt();
  const activeAtOffset = await getLedgerEnd();
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

/** Create utility TransferPreapproval (blanket for all CBTC from cbtc-network admin). Idempotent. */
export async function enableCbtcPreapprovalForParty(
  receiverParty: string
): Promise<void> {
  if (await hasCbtcPreapproval(receiverParty)) {
    console.log(`${TAG} already enabled for ${receiverParty.slice(0, 28)}…`);
    return;
  }

  const jwt = await getLedgerJwt();
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
    if (/already|duplicate|exists/i.test(text)) {
      console.log(`${TAG} create skipped (already exists) for ${receiverParty.slice(0, 28)}…`);
      return;
    }
    throw new Error(`Enable CBTC preapproval failed (${res.status}): ${text}`);
  }

  console.log(`${TAG} created TransferPreapproval for ${receiverParty.slice(0, 28)}…`);

  for (let i = 0; i < 10; i++) {
    if (await hasCbtcPreapproval(receiverParty)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
