/**
 * POST /api/transfers/create
 *
 * Phase 1: create a TransferOffer from the authenticated user's party to a
 * recipient party. Looks up the sender's holdings server-side via the m2m
 * JWT, so the client only sends recipient + amount.
 *
 * Body: { recipient: string, amountBtc: string }
 * Response: { updateId, offerContractId }
 */

import { NextResponse } from "next/server";

import { getHoldings } from "@/lib/canton";
import { NETWORK } from "@/lib/constants";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { createTransfer } from "@/lib/transfer";

const TAG = "[transfers/create]";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  console.log(`${TAG} request received`);

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Look up the user's Canton party from Supabase. Use the service client so
  // RLS doesn't reject the read — we've already verified the user identity above.
  const serviceClient = await createSupabaseServiceClient();
  const { data: partyRow, error: partyErr } = await serviceClient
    .from("party_mappings")
    .select("canton_party_id")
    .eq("user_id", user.id)
    .single();
  if (partyErr || !partyRow?.canton_party_id) {
    console.error(`${TAG} no party mapping for user=${user.id}`);
    return NextResponse.json(
      { error: "No Canton party allocated for this account" },
      { status: 400 },
    );
  }
  const senderParty = partyRow.canton_party_id as string;

  let body: { recipient?: unknown; amountBtc?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const amountBtc = typeof body.amountBtc === "string" ? body.amountBtc.trim() : "";

  if (!recipient || !recipient.includes("::")) {
    return NextResponse.json(
      { error: "recipient must be a Canton party id (includes '::')" },
      { status: 400 },
    );
  }
  if (recipient === senderParty) {
    return NextResponse.json(
      { error: "Cannot transfer to yourself" },
      { status: 400 },
    );
  }
  const parsedAmount = Number(amountBtc);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json(
      { error: "amountBtc must be a positive decimal number" },
      { status: 400 },
    );
  }

  try {
    // Fetch sender's holdings server-side — never trust the client to pick UTXOs.
    const allHoldings = await getHoldings(senderParty);
    const cbtcUnlocked = allHoldings.filter(
      (h) =>
        h.payload.instrumentId.id === NETWORK.instrumentId.id &&
        h.payload.instrumentId.admin === NETWORK.instrumentId.admin &&
        (h.payload.lock === null || h.payload.lock === undefined),
    );

    const result = await createTransfer({
      senderParty,
      receiverParty: recipient,
      amountBtc,
      inputHoldings: cbtcUnlocked,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} createTransfer failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
