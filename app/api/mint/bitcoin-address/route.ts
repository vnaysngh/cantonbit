/**
 * POST /api/mint/bitcoin-address
 *
 * Server-side proxy for coordinator /app/get-bitcoin-address.
 * Coordinator blocks direct browser calls with CORS — must go through server.
 * Also saves the bitcoin address to Supabase so list-deposit-accounts can return it cached.
 *
 * Body: { depositAccountContractId: string }
 * Response: { address: string }
 */

import { NextRequest, NextResponse } from "next/server";

import { getBitcoinAddress } from "@/lib/bitsafe";
import { requireMintRedeemRateLimit } from "@/lib/mint-redeem-guard";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const TAG = "[mint/bitcoin-address]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  const ipRate = await requireMintRedeemRateLimit(req);
  if (ipRate) return ipRate;

  try {
    const { depositAccountContractId } = await req.json() as { depositAccountContractId?: string };

    if (!depositAccountContractId) {
      console.error(`${TAG} missing depositAccountContractId`);
      return NextResponse.json({ error: "depositAccountContractId required" }, { status: 400 });
    }

    // SECURITY (IDOR): a deposit account's BTC address is per-user PII. Require the
    // authenticated user to OWN this deposit account BEFORE the coordinator read —
    // previously auth only gated the optional cache write, so any caller who knew a
    // contract id could read another user's funding address.
    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const serviceClient = await createSupabaseServiceClient();
    const { data: owned } = await serviceClient
      .from("deposit_accounts")
      .select("deposit_account_contract_id")
      .eq("user_id", user.id)
      .eq("deposit_account_contract_id", depositAccountContractId)
      .maybeSingle();
    if (!owned) {
      return NextResponse.json(
        { error: "Deposit account not found for this account" },
        { status: 404 }
      );
    }

    console.log(`${TAG} depositAccountContractId=${depositAccountContractId.slice(0, 30)}...`);
    const address = await getBitcoinAddress(depositAccountContractId);
    // Don't log the full deposit address (sensitive PII) — truncate for ops only.
    console.log(`${TAG} bitcoin address=${address.slice(0, 6)}…${address.slice(-4)}`);

    // Cache the address for list-deposit-accounts (scoped to this user's row).
    try {
      const { error } = await serviceClient
        .from("deposit_accounts")
        .update({ bitcoin_address: address })
        .eq("user_id", user.id)
        .eq("deposit_account_contract_id", depositAccountContractId);
      if (error) {
        console.warn(`${TAG} Supabase address update failed (non-fatal):`, error.message);
      } else {
        console.log(`${TAG} Supabase address update ok`);
      }
    } catch (sbErr) {
      console.warn(`${TAG} Supabase update failed (non-fatal):`, sbErr);
    }

    return NextResponse.json({ address });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} error:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
