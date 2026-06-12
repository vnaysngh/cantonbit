/**
 * Swap session: mint the Loop JWT ONCE and cache it in an httpOnly cookie.
 *
 * Called right after the user connects their Loop wallet. The browser signs the
 * "Exchange API Key" message a SINGLE time and POSTs {public_key, signature,
 * epoch} here; we exchange it for the Loop JWT and store it server-side. After
 * this, /api/swap/preapproval and /api/swap/history read the cached JWT — no
 * further wallet signatures during the swap.
 *
 *   POST   → mint + store (body: {public_key, signature, epoch})
 *   GET    → is there a valid session? ({ active: boolean }) — no signature
 *   DELETE → clear the session (on logout)
 */
import { NextResponse } from "next/server";

import {
  storeJwtSession,
  getJwtSession,
  clearJwtSession,
  loopApiBase,
  type ExchangeSig,
} from "@/lib/swap-session";

function profileParty(profile: unknown): string | null {
  const p = profile as Record<string, unknown>;
  const account = (p.account ?? {}) as Record<string, unknown>;
  const user = (p.user ?? {}) as Record<string, unknown>;
  const wallet = (p.wallet ?? {}) as Record<string, unknown>;
  const candidates = [
    p.party_id,
    p.partyId,
    p.party,
    p.canton_party_id,
    account.party_id,
    account.partyId,
    user.party_id,
    user.partyId,
    wallet.party_id,
    wallet.partyId,
  ];
  return candidates.find((x): x is string => typeof x === "string" && x.includes("::")) ?? null;
}

export async function POST(req: Request) {
  const { public_key, signature, epoch } = (await req.json().catch(() => ({}))) as Partial<ExchangeSig>;
  if (!public_key || !signature || epoch == null) {
    return NextResponse.json({ error: "need public_key, signature, epoch" }, { status: 400 });
  }
  const ok = await storeJwtSession({ public_key, signature, epoch });
  if (!ok) {
    return NextResponse.json({ error: "exchange failed" }, { status: 502 });
  }
  return NextResponse.json({ active: true });
}

export async function GET(req: Request) {
  const jwt = await getJwtSession();
  if (!jwt) return NextResponse.json({ active: false });

  const expectedParty = new URL(req.url).searchParams.get("party");
  if (!expectedParty) return NextResponse.json({ active: true });

  const profileRes = await fetch(`${loopApiBase()}/api/v1/profile`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!profileRes.ok) return NextResponse.json({ active: false });

  const party = profileParty(await profileRes.json().catch(() => ({})));
  return NextResponse.json({ active: party === expectedParty });
}

export async function DELETE() {
  await clearJwtSession();
  return NextResponse.json({ active: false });
}
