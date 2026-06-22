/**
 * GET /api/htlc/history — the logged-in user's swap history (newest first).
 * Identity resolution mirrors the rest of the app:
 *  - email session → party_mappings → their warpx party;
 *  - Loop user (no session) → ?party= (their Loop party id from the wallet).
 * Returns { orders: [...] }. No identity → empty list (not an error).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { filterHistoryOrders } from "@/lib/htlc-order-logic";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { requirePartyOwner } from "@/lib/htlc-auth";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    let party = url.searchParams.get("party") ?? "";
    const userEvm = url.searchParams.get("evm")?.trim() || null;
    if (party) {
      const auth = await requirePartyOwner(party);
      if (auth.error) return auth.error;
    }
    if (!party) {
      const supabase = await createSupabaseServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const service = await createSupabaseServiceClient();
        const { data: row } = await service
          .from("party_mappings").select("canton_party_id").eq("user_id", user.id).maybeSingle();
        party = (row?.canton_party_id as string) ?? "";
      }
    }
    if (!party) return NextResponse.json({ orders: [] });
    const raw = filterHistoryOrders(await htlcService().historyForParty(party), {
      userEvmAddress: userEvm,
    });
    const orders = raw.map((o) =>
      o.counterMode === "loop" ? { ...o, networkFeeCc: undefined } : o
    );
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
