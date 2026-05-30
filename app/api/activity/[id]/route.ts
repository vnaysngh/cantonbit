/**
 * GET /api/activity/[id]
 *
 * Unified detail endpoint for the /activity/[id] page. The id can be either:
 *   - a redeem id  (burn updateId from getRedeemHistory)
 *   - a mint id    (delivery updateId, or for pending mints the deposit-
 *                   account contractId — see getMintHistory)
 *
 * We try each source in turn and return the first hit, with a `kind` discriminator
 * so the page knows which view to render.
 *
 * Auth: Supabase session; scoped to the user's own party so one user can't
 * read another party's history.
 */

import { NextResponse } from "next/server";

import { getMintById } from "@/lib/mint-history";
import { getRedeemById } from "@/lib/redeem-history";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

const TAG = "[activity/[id]]";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
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
    // Try redeems first (cheap — ledger scan we already do).
    const redeem = await getRedeemById(partyRow.canton_party_id, id).catch(
      () => null,
    );
    if (redeem) {
      return NextResponse.json({ kind: "redeem", redeem });
    }

    // Fall back to mints.
    const mint = await getMintById(partyRow.canton_party_id, id).catch(
      () => null,
    );
    if (mint) {
      return NextResponse.json({ kind: "mint", mint });
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
