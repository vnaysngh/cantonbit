/**
 * POST /api/mint/list-deposit-accounts
 *
 * Server-side: queries Supabase first (fast), falls back to Canton ledger.
 * Loop SDK getActiveContracts returns 500 for third-party DAR templates.
 *
 * Body: { partyId: string }
 * Response: { accounts: Array<{ contractId: string }> }
 */

import { NextRequest, NextResponse } from "next/server";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

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

    // --- Supabase fast path ---
    // Check if we already have deposit accounts for this user in Supabase.
    // This avoids Canton + coordinator calls on every page refresh.
    try {
      const supabase = await createSupabaseServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const serviceClient = await createSupabaseServiceClient();
        const { data: rows } = await serviceClient
          .from("deposit_accounts")
          .select("deposit_account_contract_id, bitcoin_address")
          .eq("user_id", user.id)
          .eq("canton_party_id", partyId)
          .order("created_at", { ascending: true });

        if (rows && rows.length > 0) {
          console.log(`${TAG} Supabase hit — returning ${rows.length} cached accounts`);
          const accounts = rows.map((r) => ({
            contractId: r.deposit_account_contract_id as string,
            bitcoinAddress: (r.bitcoin_address as string | null) ?? undefined,
          }));
          return NextResponse.json({ accounts });
        }
        console.log(`${TAG} Supabase miss — falling back to Canton ledger`);
      }
    } catch (sbErr) {
      // Non-fatal — fall through to Canton query
      console.warn(`${TAG} Supabase lookup failed, falling back to Canton:`, sbErr);
    }

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

      // Query as warpxParty — the m2m JWT only has authority over it.
      // We filter by owner===partyId after fetching to return only this user's accounts.
      const warpxParty = NETWORK.warpxPartyId;
      const body = {
        filter: {
          filtersByParty: {
            [warpxParty]: {
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
      const id = (ev?.createArgument?.id as string | undefined) ?? null;
      const lpb = (ev?.createArgument?.lastProcessedBitcoinBlock as number | undefined) ?? 0;
      console.log(`${TAG} deposit account contractId=${contractId} owner=${String(owner).slice(0, 30)}... id=${id ?? "NULL"} lpb=${lpb}`);
      return { contractId, owner, id, lpb };
    }).filter((a) => a.contractId && (!a.owner || a.owner === partyId));

    console.log(`${TAG} returning ${accounts.length} deposit accounts after owner filter`);

    // Save any newly discovered accounts to Supabase for future fast lookups
    if (accounts.length > 0) {
      try {
        const supabase = await createSupabaseServerClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const serviceClient = await createSupabaseServiceClient();
          for (const account of accounts) {
            const { error } = await serviceClient
              .from("deposit_accounts")
              .upsert({
                user_id: user.id,
                canton_party_id: partyId,
                deposit_account_contract_id: account.contractId,
              }, { onConflict: "deposit_account_contract_id", ignoreDuplicates: true });
            if (error) {
              console.warn(`${TAG} Supabase upsert failed for contractId=${account.contractId}:`, error.message);
            } else {
              console.log(`${TAG} Supabase upsert ok for contractId=${account.contractId}`);
            }
          }
        }
      } catch (sbErr) {
        console.warn(`${TAG} Supabase save failed (non-fatal):`, sbErr);
      }
    }

    return NextResponse.json({ accounts });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
