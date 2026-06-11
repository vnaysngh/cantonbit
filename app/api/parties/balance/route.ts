/**
 * GET /api/parties/balance — the authenticated session party's cBTC balance,
 * read directly from the ledger (the m2m JWT can read warpx-hosted parties).
 *
 * The /swap card's useBalance hook reads the LOOP wallet's holdings — correct for
 * Loop users, but a participant-managed (email) user has no Loop provider, so their
 * real on-ledger cBTC showed as 0. This route resolves the session party (same as
 * /api/parties/me) and sums its unlocked cBTC holdings.
 */
import { NextResponse } from "next/server";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { getHoldings } from "@/lib/canton";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ total: "0", utxoCount: 0, authed: false });

    const service = await createSupabaseServiceClient();
    const { data: row } = await service
      .from("party_mappings")
      .select("canton_party_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const party = (row?.canton_party_id as string | undefined) ?? undefined;
    if (!party) return NextResponse.json({ total: "0", utxoCount: 0, authed: true });

    const holdings = await getHoldings(party);
    let sats = 0n;
    for (const h of holdings) {
      const amt = h.payload.amount ?? "0";
      sats += BigInt(Math.round(parseFloat(amt) * 1e8));
    }
    const total = (Number(sats) / 1e8).toFixed(8);
    return NextResponse.json({ total, utxoCount: holdings.length, authed: true, party });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
