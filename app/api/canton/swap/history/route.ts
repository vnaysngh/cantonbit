/**
 * GET /api/canton/swap/history?party=…
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { isSmokeTestOrderId } from "@/lib/htlc-order-logic";
import { requirePartyOwner } from "@/lib/htlc-auth";
import {
  hasNetworkFeeLedgerEntry,
  NetworkFeeLedgerLookupError
} from "@/lib/network-fee-ledger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const party = new URL(req.url).searchParams.get("party")?.trim() ?? "";
    if (!party) {
      return NextResponse.json({ error: "missing party" }, { status: 400 });
    }
    const auth = await requirePartyOwner(party);
    if (auth.error) return auth.error;
    const raw = (await cantonSwapService().history(party)).filter(
      (o) => !isSmokeTestOrderId(o.id)
    );
    // M-05: surface whether the network fee was actually collected (ledger row),
    // mirroring /api/htlc/history. Only fee-bearing orders are looked up.
    const orders = await Promise.all(
      raw.map(async (o) => {
        if (!o.networkFeeCc || Number.parseFloat(o.networkFeeCc) <= 0) return o;
        let networkFeeCollected: boolean | undefined;
        try {
          networkFeeCollected = await hasNetworkFeeLedgerEntry(o.id, "c2c");
        } catch (e) {
          if (!(e instanceof NetworkFeeLedgerLookupError)) throw e;
          networkFeeCollected = undefined;
        }
        return networkFeeCollected !== undefined
          ? { ...o, networkFeeCollected }
          : o;
      })
    );
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
