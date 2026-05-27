/**
 * GET /api/mint/debug-accounts
 *
 * Debug endpoint — queries Canton ledger directly (bypasses Supabase cache)
 * and returns all CBTCDepositAccount contracts with their id and lpb fields.
 * Use this to check if BitSafe attestors have registered the accounts.
 */

import { NextResponse } from "next/server";

import { getLedgerJwt } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

const TAG = "[mint/debug-accounts]";

export async function GET() {
  console.log(`${TAG} request received`);

  try {
    const jwt = await getLedgerJwt();

    const ledgerEndRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });
    const { offset } = await ledgerEndRes.json() as { offset?: number };
    console.log(`${TAG} ledger end offset=${offset}`);

    const warpxParty = NETWORK.warpxPartyId;
    const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [warpxParty]: {
              cumulative: [{
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: "#cbtc:CBTC.DepositAccount:CBTCDepositAccount",
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              }],
            },
          },
        },
        verbose: false,
        activeAtOffset: offset ?? 0,
      }),
      cache: "no-store",
    });

    const data = await res.json() as unknown;
    const entries = Array.isArray(data) ? data : ((data as { contractEntries?: unknown[] }).contractEntries ?? []);
    console.log(`${TAG} total entries=${entries.length}`);

    const accounts = entries.map((entry) => {
      const e = entry as {
        contractEntry?: { JsActiveContract?: { createdEvent?: { contractId?: string; createArgument?: Record<string, unknown> } } };
        JsActiveContract?: { createdEvent?: { contractId?: string; createArgument?: Record<string, unknown> } };
      };
      const ev = e.contractEntry?.JsActiveContract?.createdEvent ?? e.JsActiveContract?.createdEvent;
      const contractId = ev?.contractId ?? "";
      const args = ev?.createArgument ?? {};
      const owner = (args.owner as string | undefined) ?? null;
      const id = (args.id as string | undefined) ?? null;
      const lpb = (args.lastProcessedBitcoinBlock as number | undefined) ?? 0;

      console.log(`${TAG} contractId=${contractId.slice(0, 20)}... owner=${String(owner).slice(0, 30)}... id=${id ?? "NULL"} lpb=${lpb}`);

      return { contractId, owner, id, lpb, attestorRegistered: id !== null, lpbAdvancing: lpb > 0 };
    });

    return NextResponse.json({ network: NETWORK.name, ledgerOffset: offset, totalAccounts: accounts.length, accounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
