/**
 * GET /api/canton/raw-holdings
 *
 * Returns raw holding contracts for the warpx party — no filtering, no parsing.
 * Used to inspect the full shape of cBTC holdings on the ledger.
 */

import { NextResponse } from "next/server";

import { getLedgerJwt } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

const TAG = "[canton/raw-holdings]";

export async function GET() {
  console.log(`${TAG} request received`);

  try {
    const jwt = await getLedgerJwt();
    const warpxParty = NETWORK.warpxPartyId;

    const ledgerEndRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });
    const { offset } = await ledgerEndRes.json() as { offset?: number };
    console.log(`${TAG} ledger end offset=${offset}`);

    const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [warpxParty]: {
              cumulative: [{
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              }],
            },
          },
        },
        verbose: true,
        activeAtOffset: offset ?? 0,
      }),
      cache: "no-store",
    });

    console.log(`${TAG} active-contracts status=${res.status}`);

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      return NextResponse.json({ error: text }, { status: 502 });
    }

    const raw = await res.json() as unknown;
    const entries = Array.isArray(raw)
      ? raw
      : ((raw as { contractEntries?: unknown[] }).contractEntries ?? []);

    console.log(`${TAG} total entries=${entries.length}`);

    return NextResponse.json({ network: NETWORK.name, ledgerOffset: offset, totalEntries: entries.length, entries });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
