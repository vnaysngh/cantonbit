/**
 * POST /api/htlc/auto-refund — sweep: refund all counter-locked swaps whose Canton
 * timelock has passed (frees the solver's cBTC). The daemon calls this periodically
 * (Cancore parity: "platform automatically refunds after timeout"). Idempotent per
 * order — a swap that's already refunded/claimed is skipped.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST() {
  try {
    const svc = htlcService();
    const due = await svc.refundableOrders();
    const results: { id: string; ok: boolean; detail: string }[] = [];
    for (const o of due) {
      try {
        const { updateId } = await svc.refundCounter(o.id);
        results.push({ id: o.id, ok: true, detail: updateId });
      } catch (e) {
        results.push({ id: o.id, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    return NextResponse.json({ due: due.length, refunded: results.filter((r) => r.ok).length, results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
