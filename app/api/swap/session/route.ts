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
  type ExchangeSig,
} from "@/lib/swap-session";

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

export async function GET() {
  const jwt = await getJwtSession();
  return NextResponse.json({ active: jwt != null });
}

export async function DELETE() {
  await clearJwtSession();
  return NextResponse.json({ active: false });
}
