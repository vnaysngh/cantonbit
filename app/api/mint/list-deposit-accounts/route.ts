/**
 * POST /api/mint/list-deposit-accounts
 *
 * Server-side: queries LEDGER_HOST for CBTCDepositAccount contracts owned by partyId.
 * Loop SDK getActiveContracts returns 500 for third-party DAR templates.
 *
 * Body: { partyId: string }
 * Response: { accounts: Array<{ contractId: string }> }
 */

import { NextRequest, NextResponse } from "next/server";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

// active-contracts TemplateFilter requires package NAME alias, not hash.
// "#cbtc" alias is confirmed working via live test against the mainnet ledger.
const DEPOSIT_ACCOUNT_TEMPLATE_ID =
  "#cbtc:CBTC.DepositAccount:CBTCDepositAccount";

const TAG = "[mint/list-deposit-accounts]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { partyId } = await req.json() as { partyId?: string };
    if (!partyId) {
      console.error(`${TAG} missing partyId`);
      return NextResponse.json({ error: "partyId required" }, { status: 400 });
    }

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}...`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);

    const queryLedger = async (token: string) => {
      console.log(`${TAG} fetching ledger end offset...`);
      const ledgerEndRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      console.log(`${TAG} ledger-end status=${ledgerEndRes.status}`);
      if (ledgerEndRes.status === 401) return { status: 401 as const };
      if (!ledgerEndRes.ok) throw new Error(`getLedgerEnd failed (${ledgerEndRes.status})`);
      const { offset } = await ledgerEndRes.json() as { offset?: number };
      console.log(`${TAG} ledger end offset=${offset}`);

      const body = {
        filter: {
          filtersByParty: {
            [partyId]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: DEPOSIT_ACCOUNT_TEMPLATE_ID,
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset ?? 0,
      };

      console.log(`${TAG} querying active-contracts for CBTCDepositAccount...`);
      const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      console.log(`${TAG} active-contracts status=${res.status}`);
      if (res.status === 401) return { status: 401 as const };
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        throw new Error(`active-contracts failed (${res.status}): ${text}`);
      }

      // The v2 active-contracts endpoint returns a plain JSON array, not a wrapped object.
      const data = await res.json() as unknown;
      const entries = Array.isArray(data) ? data : ((data as { contractEntries?: unknown[]; result?: unknown[] }).contractEntries ?? (data as { result?: unknown[] }).result ?? []);
      console.log(`${TAG} found ${entries.length} CBTCDepositAccount entries`);
      return { status: 200 as const, entries };
    };

    console.log(`${TAG} fetching JWT...`);
    let jwt = await getLedgerJwt();

    let result = await queryLedger(jwt);

    if (result.status === 401) {
      console.warn(`${TAG} 401 — invalidating JWT cache and retrying...`);
      invalidateLedgerJwtCache();
      jwt = await getLedgerJwt();
      result = await queryLedger(jwt);
      if (result.status === 401) {
        console.error(`${TAG} still 401 after JWT refresh`);
        return NextResponse.json({ error: "Authentication failed after JWT refresh" }, { status: 401 });
      }
    }

    const accounts = (result.entries ?? []).map((entry) => {
      // Ledger v2 response: entry.contractEntry.JsActiveContract.createdEvent
      const e = entry as {
        contractEntry?: {
          JsActiveContract?: {
            createdEvent?: {
              contractId?: string;
              createArgument?: Record<string, unknown>;
            };
          };
        };
        // Fallback: some older shapes nest directly
        JsActiveContract?: {
          createdEvent?: {
            contractId?: string;
            createArgument?: Record<string, unknown>;
          };
        };
      };
      const ev =
        e.contractEntry?.JsActiveContract?.createdEvent ??
        e.JsActiveContract?.createdEvent;
      const contractId = ev?.contractId ?? "";
      const owner = (ev?.createArgument?.owner as string | undefined) ?? null;
      console.log(`${TAG} deposit account contractId=${contractId} owner=${String(owner).slice(0, 30)}...`);
      return { contractId, owner };
    }).filter((a) => a.contractId && (!a.owner || a.owner === partyId));

    console.log(`${TAG} returning ${accounts.length} deposit accounts after owner filter`);
    return NextResponse.json({ accounts });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
