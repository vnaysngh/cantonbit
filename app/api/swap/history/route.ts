/**
 * Server-side read of the user's Loop transfer history, to get the AUTHORITATIVE
 * outcome of a cBTC delivery (status "completed" = accepted, "rejected" =
 * rejected). Same reason as the preapproval route: /history needs the Loop JWT
 * (api_key) and is CORS-blocked from the browser.
 *
 * The JWT is minted ONCE at wallet connect and cached in an httpOnly session
 * cookie (see /api/swap/session + lib/swap-session.ts). This route just reads
 * that cached JWT — NO wallet signature here. If the session is missing/expired
 * we return 401 so the client re-mints (one signature) and retries.
 *
 * Returns the recent CBTC "received" transfers with their status, so the caller
 * can match the one for their swap (by amount + sender + recency) and report it
 * to the solver.
 */
import { NextResponse } from "next/server";

import { NETWORK } from "@/lib/constants";
import { getJwtSession, loopApiBase } from "@/lib/swap-session";

interface HistoryTransfer {
  id: string;
  amount: string;
  created_at: string;
  from: string;
  to: string;
  type: string; // "received" | "sent"
  status: string; // "completed" | "rejected" | "pending" | ...
  failure_reason: string;
  instrument_id: string;
  instrument_admin: string;
}

export async function GET() {
  const apiKey = await getJwtSession();
  if (!apiKey) {
    return NextResponse.json({ error: "no session", needsSignature: true }, { status: 401 });
  }

  const base = loopApiBase();
  try {
    const url = `${base}/api/v1/history?limit=20&sortBy=created_at&sortOrder=desc&type=any`;
    const hr = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (hr.status === 401 || hr.status === 403) {
      return NextResponse.json({ error: "session expired", needsSignature: true }, { status: 401 });
    }
    if (!hr.ok) {
      return NextResponse.json({ error: "history failed", historyStatus: hr.status }, { status: 502 });
    }
    const data = (await hr.json()) as { transfers?: HistoryTransfer[] };
    const cbtcAdmin = NETWORK.decentralizedPartyId;
    const transfers = (data.transfers ?? [])
      .filter((t) => t.type === "received" && t.instrument_admin === cbtcAdmin)
      .map((t) => ({
        id: t.id,
        amount: t.amount,
        from: t.from,
        status: t.status, // completed | rejected | pending
        created_at: t.created_at,
      }));
    return NextResponse.json({ transfers });
  } catch (e) {
    return NextResponse.json({ error: "history error", detail: String(e) }, { status: 502 });
  }
}
