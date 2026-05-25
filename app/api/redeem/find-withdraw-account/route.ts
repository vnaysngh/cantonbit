/**
 * POST /api/redeem/find-withdraw-account
 *
 * Server-side handler for checking if the user already has a CBTCWithdrawAccount
 * for a given destination address. Queries LEDGER_HOST directly (m2m JWT).
 *
 * Body: { partyId: string; destinationBtcAddress: string }
 * Response: { contractId: string; createdEventBlob: string } | { contractId: null }
 */

import { NextRequest, NextResponse } from "next/server";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

// active-contracts TemplateFilter requires package NAME alias, not hash.
// "#cbtc" alias is confirmed working via live test against the mainnet ledger.
const WITHDRAW_ACCOUNT_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawAccount:CBTCWithdrawAccount";

const TAG = "[redeem/find-withdraw-account]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { partyId, destinationBtcAddress } = await req.json() as {
      partyId?: string;
      destinationBtcAddress?: string;
    };

    if (!partyId || !destinationBtcAddress) {
      console.error(`${TAG} missing partyId or destinationBtcAddress`);
      return NextResponse.json(
        { error: "partyId and destinationBtcAddress required" },
        { status: 400 },
      );
    }

    console.log(`${TAG} partyId=${partyId.slice(0, 30)}... btcAddress=${destinationBtcAddress}`);
    console.log(`${TAG} network=${NETWORK.name} ledgerHost=${NETWORK.ledgerHost}`);

    const queryLedger = async (token: string) => {
      // Get ledger end offset
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
                        templateId: WITHDRAW_ACCOUNT_TEMPLATE_ID,
                        includeCreatedEventBlob: true,
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

      console.log(`${TAG} querying active-contracts for CBTCWithdrawAccount...`);
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
      const raw = await res.json() as unknown;
      const entries = Array.isArray(raw) ? raw : ((raw as { contractEntries?: unknown[] }).contractEntries ?? (raw as { result?: unknown[] }).result ?? []);
      console.log(`${TAG} found ${entries.length} CBTCWithdrawAccount entries`);
      return { status: 200 as const, entries };
    };

    console.log(`${TAG} fetching JWT...`);
    let jwt = await getLedgerJwt();
    console.log(`${TAG} JWT obtained, length=${jwt.length}`);

    let result = await queryLedger(jwt);

    if (result.status === 401) {
      console.warn(`${TAG} 401 from ledger — invalidating JWT cache and retrying...`);
      invalidateLedgerJwtCache();
      jwt = await getLedgerJwt();
      result = await queryLedger(jwt);
      if (result.status === 401) {
        console.error(`${TAG} still 401 after JWT refresh — auth failure`);
        return NextResponse.json({ error: "Authentication failed — JWT invalid after refresh" }, { status: 401 });
      }
    }

    const entries = result.entries ?? [];

    for (const entry of entries) {
      // Ledger v2 response: entry.contractEntry.JsActiveContract.createdEvent
      const e = entry as {
        contractEntry?: {
          JsActiveContract?: {
            createdEvent?: {
              contractId?: string;
              createArgument?: Record<string, unknown>;
              createdEventBlob?: string;
            };
          };
        };
        JsActiveContract?: {
          createdEvent?: {
            contractId?: string;
            createArgument?: Record<string, unknown>;
            createdEventBlob?: string;
          };
        };
      };
      const ev =
        e.contractEntry?.JsActiveContract?.createdEvent ??
        e.JsActiveContract?.createdEvent;
      if (!ev?.contractId) continue;

      const arg = ev.createArgument ?? {};
      const owner = arg.owner as string | undefined;
      const addr = arg.destinationBtcAddress as string | undefined;

      console.log(`${TAG} checking contract=${ev.contractId.slice(0, 20)}... owner=${String(owner).slice(0, 20)}... addr=${addr}`);

      if (owner && owner !== partyId) continue;
      if (addr === destinationBtcAddress) {
        console.log(`${TAG} found matching withdraw account contractId=${ev.contractId}`);
        return NextResponse.json({
          contractId: ev.contractId,
          createdEventBlob: ev.createdEventBlob ?? "",
        });
      }
    }

    console.log(`${TAG} no matching withdraw account found for btcAddress=${destinationBtcAddress}`);
    return NextResponse.json({ contractId: null });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
