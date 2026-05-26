/**
 * POST /api/parties/allocate
 *
 * Allocates a Canton party for the authenticated user if they don't have one yet.
 * Idempotent — safe to call multiple times, always returns the same partyId.
 *
 * Security:
 * - Reads user identity from the Supabase session (server-side) — not from request body.
 * - Writes to party_mappings using the service role key (bypasses RLS).
 * - Browser never has write access to party_mappings (RLS blocks it).
 * - canton_party_id is unique — DB constraint prevents double-allocation.
 * - Write-once — once a party is stored, we never update it.
 *
 * Response: { partyId: string; isNew: boolean }
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getLedgerJwt } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const TAG = "[parties/allocate]";

export async function POST() {
  try {
    // 1. Get authenticated user from session — never trust request body for identity
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error(`${TAG} unauthenticated request`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log(`${TAG} user=${user.id} email=${user.email}`);

    // 2. Check if this user already has a party (idempotency)
    const serviceClient = await createSupabaseServiceClient();
    const { data: existing, error: lookupError } = await serviceClient
      .from("party_mappings")
      .select("canton_party_id")
      .eq("user_id", user.id)
      .single();

    if (lookupError && lookupError.code !== "PGRST116") {
      // PGRST116 = "no rows found" — expected for new users
      console.error(`${TAG} DB lookup error:`, lookupError);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (existing?.canton_party_id) {
      console.log(`${TAG} returning existing party=${existing.canton_party_id}`);
      return NextResponse.json({ partyId: existing.canton_party_id, isNew: false });
    }

    // 3. New user — allocate a Canton party
    const uuid = randomUUID();
    const partyHint = `cbtc-user-${uuid}`;
    console.log(`${TAG} allocating new party hint=${partyHint}`);

    const jwt = await getLedgerJwt();
    const res = await fetch(`${NETWORK.ledgerHost}/v2/parties`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ partyIdHint: partyHint }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.error(`${TAG} Canton party allocation failed status=${res.status} body=${text}`);
      return NextResponse.json(
        { error: `Party allocation failed (${res.status}): ${text}` },
        { status: 502 },
      );
    }

    const data = await res.json() as { partyDetails?: { party?: string } };
    const partyId = data.partyDetails?.party;

    if (!partyId) {
      console.error(`${TAG} Canton returned no partyId:`, JSON.stringify(data));
      return NextResponse.json({ error: "Canton returned no partyId" }, { status: 502 });
    }

    console.log(`${TAG} allocated partyId=${partyId}`);

    // 4. Store the mapping — write-once, service role bypasses RLS
    const { error: insertError } = await serviceClient
      .from("party_mappings")
      .insert({
        user_id: user.id,
        canton_party_id: partyId,
        party_hint: partyHint,
      });

    if (insertError) {
      console.error(`${TAG} DB insert error code=${insertError.code} message=${insertError.message} details=${insertError.details} hint=${insertError.hint}`);
      // Could be a race condition — check if another request already inserted
      if (insertError.code === "23505") {
        // Unique violation — another request beat us to it, fetch the existing one
        const { data: raceWinner } = await serviceClient
          .from("party_mappings")
          .select("canton_party_id")
          .eq("user_id", user.id)
          .single();

        if (raceWinner?.canton_party_id) {
          console.log(`${TAG} race condition resolved, returning existing=${raceWinner.canton_party_id}`);
          return NextResponse.json({ partyId: raceWinner.canton_party_id, isNew: false });
        }
      }
      console.error(`${TAG} DB insert error:`, insertError);
      return NextResponse.json({ error: "Failed to store party mapping" }, { status: 500 });
    }

    console.log(`${TAG} party mapping stored successfully`);
    return NextResponse.json({ partyId, isNew: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} unexpected error:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
