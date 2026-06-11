/**
 * POST /api/htlc/auto-refund — the expiry sweep, BOTH directions. The daemon calls
 * this every ~60s (Cancore parity: "platform automatically refunds after timeout").
 * Idempotent per order. Covers:
 *  - evm→canton: solver's expired cBTC HtlcLock → refundCounter.
 *  - canton→evm: USER's expired cBTC HtlcLock → refundMainCanton (CanActAs — fully
 *    automated; the user never has to click anything).
 *  - evm→canton stuck in main_locked past the EVM timelock: bookkeeping only (the
 *    user's WBTC retake is their own EVM action; nothing of ours is locked).
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST() {
  try {
    const svc = htlcService();
    const { forwardCounter, reverseMain, staleForwardMain } = await svc.expiredOrders();
    const results: { id: string; kind: string; ok: boolean; detail: string }[] = [];
    const run = async (id: string, kind: string, fn: () => Promise<unknown>) => {
      try { const r = (await fn()) as { updateId?: string } | undefined; results.push({ id, kind, ok: true, detail: r?.updateId ?? "ok" }); }
      catch (e) { results.push({ id, kind, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) }); }
    };
    for (const o of forwardCounter) await run(o.id, "refund-counter", () => svc.refundCounter(o.id));
    for (const o of reverseMain) await run(o.id, "refund-main", () => svc.refundMainCanton(o.id));
    for (const o of staleForwardMain) await run(o.id, "mark-stale", () => svc.markRefunded(o.id));
    const due = forwardCounter.length + reverseMain.length + staleForwardMain.length;
    return NextResponse.json({ due, refunded: results.filter((r) => r.ok).length, results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
