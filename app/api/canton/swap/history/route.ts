/**
 * GET /api/canton/swap/history?party=…
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { isSmokeTestOrderId } from "@/lib/htlc-order-logic";
import { requirePartyOwner } from "@/lib/htlc-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const party = new URL(req.url).searchParams.get("party")?.trim() ?? "";
    if (!party) {
      return NextResponse.json({ error: "missing party" }, { status: 400 });
    }
    const auth = await requirePartyOwner(party);
    if (auth.error) return auth.error;
    const orders = (await cantonSwapService().history(party)).filter(
      (o) => !isSmokeTestOrderId(o.id)
    );
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
