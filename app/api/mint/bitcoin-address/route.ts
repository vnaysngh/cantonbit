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
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const TAG = "[mint/bitcoin-address]";

export async function POST(req: NextRequest) {
  console.log(`${TAG} request received`);

  try {
    const { depositAccountContractId } = await req.json() as { depositAccountContractId?: string };

    if (!depositAccountContractId) {
      console.error(`${TAG} missing depositAccountContractId`);
      return NextResponse.json({ error: "depositAccountContractId required" }, { status: 400 });
    }

    console.log(`${TAG} depositAccountContractId=${depositAccountContractId.slice(0, 30)}...`);
    const address = await getBitcoinAddress(depositAccountContractId);
    console.log(`${TAG} bitcoin address=${address}`);

    // Save bitcoin address to Supabase so next page load can return it without coordinator call
    try {
      const supabase = await createSupabaseServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const serviceClient = await createSupabaseServiceClient();
        const { error } = await serviceClient
          .from("deposit_accounts")
          .update({ bitcoin_address: address })
          .eq("deposit_account_contract_id", depositAccountContractId);
        if (error) {
          console.warn(`${TAG} Supabase address update failed (non-fatal):`, error.message);
        } else {
          console.log(`${TAG} Supabase address update ok`);
        }
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
