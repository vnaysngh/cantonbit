import "server-only";

import { NextResponse } from "next/server";

import { isParticipantManagedParty } from "@/lib/htlc-auth";
import { resolveSessionParty } from "@/lib/session-party";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const buckets = new Map<string, number[]>();

function rateLimitOk(userId: string): boolean {
  const now = Date.now();
  const hits = (buckets.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    buckets.set(userId, hits);
    return false;
  }
  hits.push(now);
  buckets.set(userId, hits);
  return true;
}

/** Session party + participant-managed gate for P2P transfer APIs. */
export async function requireManagedTransferSession(): Promise<
  | { partyId: string; userId: string; error: null }
  | { partyId: null; userId: null; error: NextResponse }
> {
  const session = await resolveSessionParty();
  if (session.error) {
    return { partyId: null, userId: null, error: session.error };
  }

  if (!(await isParticipantManagedParty(session.partyId))) {
    return {
      partyId: null,
      userId: null,
      error: NextResponse.json(
        {
          error:
            "P2P transfers are only available for email wallet accounts. Loop wallet users should send assets from the Loop wallet."
        },
        { status: 403 }
      )
    };
  }

  if (!rateLimitOk(session.userId)) {
    return {
      partyId: null,
      userId: null,
      error: NextResponse.json(
        { error: "Too many transfer requests — please wait a moment." },
        { status: 429 }
      )
    };
  }

  return session;
}
