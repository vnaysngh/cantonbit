/**
 * GET /api/transfers/outgoing
 *
 * List active TransferOffers the authenticated user created (sender side).
 */
import { NextResponse } from "next/server";

import { requireManagedTransferSession } from "@/lib/transfer-session";
import { listOutgoingOffers } from "@/lib/transfer";

const TAG = "[transfers/outgoing]";

export const dynamic = "force-dynamic";

export async function GET() {
  console.log(`${TAG} request received`);

  const session = await requireManagedTransferSession();
  if (session.error) return session.error;

  try {
    const offers = await listOutgoingOffers(session.partyId);
    return NextResponse.json({ offers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} listOutgoingOffers failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
