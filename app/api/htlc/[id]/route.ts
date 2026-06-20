/**
 * GET /api/htlc/{id} — fetch a swap order's status (drives the UI timeline).
 */
import { NextResponse } from "next/server";
import { requireOrderOwnerOrDaemon } from "@/lib/htlc-auth";
import { isNetworkFeeEnabled } from "@/lib/canton-network-fee";
import { hasNetworkFeeLedgerEntry, NetworkFeeLedgerLookupError } from "@/lib/network-fee-ledger";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwnerOrDaemon(req, id);
    if (auth.error) return auth.error;
    const order = auth.order;
    if (
      isNetworkFeeEnabled() &&
      order.counterMode === "loop" &&
      order.networkFeeCc &&
      Number.parseFloat(order.networkFeeCc) > 0
    ) {
      let networkFeeCollected: boolean | undefined;
      try {
        networkFeeCollected = await hasNetworkFeeLedgerEntry(id, "htlc");
      } catch (e) {
        if (!(e instanceof NetworkFeeLedgerLookupError)) throw e;
        networkFeeCollected = undefined;
      }
      return NextResponse.json({
        order: {
          ...order,
          ...(networkFeeCollected !== undefined ? { networkFeeCollected } : {})
        }
      });
    }
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
