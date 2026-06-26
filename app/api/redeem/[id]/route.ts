/**
 * GET /api/redeem/[id]
 *
 * Returns a single redeem (by its burn updateId) for the detail page,
 * reconstructed from the ledger. Auth: Supabase session; scoped to the user's
 * own party so one user can't read another party's redeem.
 */

import { NextRequest, NextResponse } from "next/server";

import { getRedeemById } from "@/lib/redeem-history";
import { requireMintRedeemRateLimit } from "@/lib/mint-redeem-guard";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

const TAG = "[redeem/[id]]";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rate = await requireMintRedeemRateLimit(req, user.id);
  if (rate) return rate;

  const serviceClient = await createSupabaseServiceClient();
  const { data: partyRow } = await serviceClient
    .from("party_mappings")
    .select("canton_party_id")
    .eq("user_id", user.id)
    .single();

  if (!partyRow?.canton_party_id) {
    return NextResponse.json({ error: "No party for user" }, { status: 404 });
  }

  try {
    const redeem = await getRedeemById(partyRow.canton_party_id, id);
    if (!redeem) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ redeem });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
