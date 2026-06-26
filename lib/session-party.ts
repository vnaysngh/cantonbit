import "server-only";

import { NextResponse } from "next/server";

import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import { mainnetBlockedResponse } from "@/lib/mainnet-guard";

/**
 * Resolve the Canton party that the *authenticated session* owns, and (if the
 * caller supplied one) verify the client-provided party id matches it.
 *
 * This is the single chokepoint that prevents privilege escalation: the m2m
 * JWT has CanActAs over BOTH the warpx (treasury) party and every cbtc-user
 * party, so a route that trusted a client-supplied `partyId` would let any
 * logged-in user act as warpx (burn treasury funds) or another user. Every
 * route that does a ledger read/write for "the user's party" MUST get that
 * party from here — never from the request body/query.
 *
 * On any failure this returns a ready-to-send NextResponse (401/400/403) in
 * `error`; callers should early-return it. On success `partyId` is the
 * session-owned party and `error` is null.
 */
export async function resolveSessionParty(
  /** Optional party id the client sent. If present, it MUST equal the session
   *  party or we reject with 403. We never *use* this value — only compare. */
  clientPartyId?: string | null,
): Promise<
  | { partyId: string; userId: string; error: null }
  | { partyId: null; userId: null; error: NextResponse }
> {
  const mainnetBlocked = mainnetBlockedResponse();
  if (mainnetBlocked) {
    return {
      partyId: null,
      userId: null,
      error: mainnetBlocked
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      partyId: null,
      userId: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const serviceClient = await createSupabaseServiceClient();
  const { data: partyRow, error: partyErr } = await serviceClient
    .from("party_mappings")
    .select("canton_party_id")
    .eq("user_id", user.id)
    .single();

  if (partyErr || !partyRow?.canton_party_id) {
    return {
      partyId: null,
      userId: null,
      error: NextResponse.json(
        { error: "No Canton party allocated for this account" },
        { status: 400 },
      ),
    };
  }

  const sessionParty = partyRow.canton_party_id as string;

  // Accept-but-validate: if the client sent a partyId, it must be THEIRS.
  // Trimmed compare so trailing whitespace doesn't cause false rejects.
  if (
    clientPartyId != null &&
    clientPartyId.trim() !== "" &&
    clientPartyId.trim() !== sessionParty
  ) {
    console.error(
      `[session-party] party mismatch user=${user.id} session=${sessionParty.slice(
        0,
        24,
      )}... client=${clientPartyId.slice(0, 24)}... — rejecting`,
    );
    return {
      partyId: null,
      userId: null,
      error: NextResponse.json(
        { error: "Requested party does not match the authenticated account." },
        { status: 403 },
      ),
    };
  }

  return { partyId: sessionParty, userId: user.id, error: null };
}
