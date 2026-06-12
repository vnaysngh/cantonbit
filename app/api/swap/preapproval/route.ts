/**
 * Server-side check: does the user have CBTC auto-accept (utility preapproval)
 * turned on?
 *
 * Why server-side: the per-admin preapproval data lives at
 * cantonloop.com/api/v1/profile, which (a) is CORS-blocked from the browser and
 * (b) requires the Loop JWT (api_key), not the connect auth_token.
 *
 * The JWT is minted ONCE at wallet connect and cached in an httpOnly session
 * cookie (see /api/swap/session + lib/swap-session.ts). This route just reads
 * that cached JWT — NO wallet signature here. If the session is missing/expired
 * we return 401 so the client re-mints (one signature) and retries.
 */
import { NextResponse } from "next/server";

import { NETWORK } from "@/lib/constants";
import { getJwtSession, loopApiBase } from "@/lib/swap-session";

export async function GET() {
  const apiKey = await getJwtSession();
  if (!apiKey) {
    return NextResponse.json(
      { error: "no session", needsSignature: true },
      { status: 401 }
    );
  }

  const base = loopApiBase();
  const cbtcAdmin = NETWORK.decentralizedPartyId;

  // Read the profile with the cached JWT.
  let preapprovals: { instrument_admin?: string }[] = [];
  try {
    const pr = await fetch(`${base}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (pr.status === 401 || pr.status === 403) {
      // JWT rejected (expired/invalid despite the cookie) — ask the client to re-mint.
      return NextResponse.json(
        { error: "session expired", needsSignature: true },
        { status: 401 }
      );
    }
    if (!pr.ok) {
      return NextResponse.json(
        { error: "profile failed", profileStatus: pr.status },
        { status: 502 }
      );
    }
    const profile = (await pr.json()) as {
      utility_preapprovals?: { instrument_admin?: string }[];
    };
    preapprovals = Array.isArray(profile.utility_preapprovals)
      ? profile.utility_preapprovals
      : [];
  } catch (e) {
    return NextResponse.json(
      { error: "profile error", detail: String(e) },
      { status: 502 }
    );
  }

  // Is the CBTC admin preapproved (auto-accept ON for CBTC)?
  const cbtcAutoAccept = preapprovals.some(
    (p) => p.instrument_admin === cbtcAdmin
  );
  return NextResponse.json({ cbtcAutoAccept });
}
