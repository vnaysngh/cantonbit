/**
 * POST /api/parties/register-loop   body: { partyId: string }
 *
 * Registers the user's CONNECTED LOOP WALLET party as their Canton identity.
 * Replaces the old /api/parties/allocate flow (which created a party on our own
 * validator). The party now comes from the user's Loop wallet — they proved
 * ownership by connecting it — so we accept it from the client and bind it to
 * their Supabase session in party_mappings.
 *
 * Security model:
 * - User identity comes from the Supabase session (never the request body).
 * - The party_id comes from the client, but it is only ACCEPTED as the user's
 *   own identity — it's stored against THIS user's row. A user registering a
 *   party only affects their own mapping; they gain no authority over it (all
 *   user-signed Canton actions are authorized by the Loop wallet itself, not by
 *   this mapping). The mapping is the server's "which party does this session
 *   own" anchor for read queries + actAs-as-this-user routes.
 * - canton_party_id is UNIQUE: a party already bound to a DIFFERENT user is
 *   rejected (can't hijack someone else's registered party).
 * - Idempotent: re-registering the same party for the same user is a no-op.
 *
 * Response: { partyId: string; isNew: boolean }
 */

import { NextResponse } from "next/server";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { partyMappingEmailPayload, syncPartyMappingEmail } from "@/lib/party-mapping-email";
import { loopProfileParty } from "@/lib/htlc-auth";
import { exchangeForJwt, loopApiBase, storeJwtCookie, type ExchangeSig } from "@/lib/swap-session";

const TAG = "[parties/register-loop]";

/** Minimal sanity check for a Canton party id (e.g. "name::1220abcd..."). */
function isPlausibleParty(p: unknown): p is string {
  return typeof p === "string" && p.includes("::") && p.length >= 16 && p.length <= 300;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { partyId?: unknown } & Partial<ExchangeSig>;
    const partyId = body.partyId;
    if (!isPlausibleParty(partyId)) {
      return NextResponse.json({ error: "Missing or invalid partyId" }, { status: 400 });
    }
    if (!body.public_key || !body.signature || body.epoch == null) {
      return NextResponse.json({ error: "Loop wallet signature required" }, { status: 401 });
    }
    const jwt = await exchangeForJwt({
      public_key: body.public_key,
      signature: body.signature,
      epoch: body.epoch,
    });
    if (!jwt) return NextResponse.json({ error: "Loop signature exchange failed" }, { status: 401 });
    const profileRes = await fetch(`${loopApiBase()}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });
    if (!profileRes.ok) {
      return NextResponse.json({ error: "Loop profile verification failed" }, { status: 401 });
    }
    const profileParty = loopProfileParty(await profileRes.json().catch(() => ({})));
    if (!profileParty) {
      return NextResponse.json({ error: "Loop profile did not include a verifiable party" }, { status: 401 });
    }
    if (profileParty !== partyId) {
      return NextResponse.json({ error: "Loop signature does not match requested party" }, { status: 403 });
    }
    await storeJwtCookie(jwt);

    // Identity now comes from the Loop wallet connection (no login gate). If a
    // legacy Supabase session exists, we still persist the mapping for it; if
    // not, registration is a no-op success — the client already holds the Loop
    // party and uses it directly (user-signed Canton actions are authorized by
    // the Loop wallet, not by a server session).
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
    if (!user) {
      return NextResponse.json({ partyId, isNew: false, sessionless: true });
    }

    const serviceClient = await createSupabaseServiceClient();

    // 2. Already mapped? Decide idempotency vs. conflict.
    const { data: existing, error: lookupError } = await serviceClient
      .from("party_mappings")
      .select("user_id, canton_party_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) {
      console.error(`${TAG} lookup error:`, lookupError);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (existing?.canton_party_id) {
      if (existing.canton_party_id === partyId) {
        await syncPartyMappingEmail(serviceClient, user.id, user);
        return NextResponse.json({ partyId, isNew: false }); // already registered
      }
      // The user previously had a DIFFERENT party (e.g. an old validator-created
      // one). Update it to their Loop party — the Loop wallet is now the source
      // of truth for this user's identity.
      const { error: updErr } = await serviceClient
        .from("party_mappings")
        .update({
          canton_party_id: partyId,
          party_hint: "loop-wallet",
          ...partyMappingEmailPayload(user)
        })
        .eq("user_id", user.id);
      if (updErr) {
        if (updErr.code === "23505") {
          // The Loop party is already bound to another user — refuse.
          return NextResponse.json(
            { error: "This Loop party is already registered to another account." },
            { status: 409 },
          );
        }
        console.error(`${TAG} update error:`, updErr);
        return NextResponse.json({ error: "Failed to update party mapping" }, { status: 500 });
      }
      console.log(`${TAG} user=${user.id} re-pointed to loop party=${partyId}`);
      return NextResponse.json({ partyId, isNew: false });
    }

    // 3. First registration — insert.
    const { error: insertError } = await serviceClient
      .from("party_mappings")
      .insert({
        user_id: user.id,
        canton_party_id: partyId,
        party_hint: "loop-wallet",
        ...partyMappingEmailPayload(user)
      });

    if (insertError) {
      if (insertError.code === "23505") {
        // Either a race for this user, or the party belongs to another user.
        const { data: byParty } = await serviceClient
          .from("party_mappings")
          .select("user_id")
          .eq("canton_party_id", partyId)
          .maybeSingle();
        if (byParty && byParty.user_id !== user.id) {
          return NextResponse.json(
            { error: "This Loop party is already registered to another account." },
            { status: 409 },
          );
        }
        // Race for the same user — treat as success.
        return NextResponse.json({ partyId, isNew: false });
      }
      console.error(`${TAG} insert error:`, insertError);
      return NextResponse.json({ error: "Failed to store party mapping" }, { status: 500 });
    }

    console.log(`${TAG} user=${user.id} registered loop party=${partyId}`);
    return NextResponse.json({ partyId, isNew: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
