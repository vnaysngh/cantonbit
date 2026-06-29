/**
 * GET /api/canton/swap/history?party=…
 */
import { NextResponse } from "next/server";

import { cantonSwapService } from "@/lib/canton-swap-service";
import { isSmokeTestOrderId, parsePartyHistoryQuery } from "@/lib/htlc-order-logic";
import { filterVisibleC2cHistoryOrders } from "@/lib/swap-order-visibility";
import { requirePartyOwner } from "@/lib/htlc-auth";
import {
  networkFeeLedgerEntrySet,
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
    const query = parsePartyHistoryQuery(new URL(req.url));
    const { orders: page, hasMore } = await cantonSwapService().history(
      party,
      query
    );
    const raw = filterVisibleC2cHistoryOrders(
      page.filter((o) => !isSmokeTestOrderId(o.id))
    );
    const feeOrderIds = raw
      .filter((o) => o.networkFeeCc && Number.parseFloat(o.networkFeeCc) > 0)
      .map((o) => o.id);
    let collected = new Set<string>();
    let feeLookupFailed = false;
    try {
      collected = await networkFeeLedgerEntrySet(feeOrderIds, "c2c");
    } catch (e) {
      if (!(e instanceof NetworkFeeLedgerLookupError)) throw e;
      feeLookupFailed = true;
    }
    const orders = raw.map((o) => {
      if (!o.networkFeeCc || Number.parseFloat(o.networkFeeCc) <= 0) return o;
      if (feeLookupFailed) return { ...o, networkFeeCollected: undefined };
      return { ...o, networkFeeCollected: collected.has(o.id) };
    });
    return NextResponse.json({ orders, hasMore });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
