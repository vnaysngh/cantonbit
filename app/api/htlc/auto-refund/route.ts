/**
 * POST/GET /api/htlc/auto-refund — the expiry sweep, BOTH directions. Runs from
 * TWO triggers so refunds survive even if the daemon is down:
 *   - the solver daemon's 60s timer (POST), and
 *   - a scheduled cron (GET — Vercel cron / external worker, Bearer CRON_SECRET).
 * Idempotent per order. Covers forward/reverse cBTC refunds + Loop custody returns.
 *
 * AUTH: when CRON_SECRET is set, GET requires `Authorization: Bearer $CRON_SECRET`
 * (cron path). POST (the local daemon) is allowed without it for dev convenience —
 * in prod, run the daemon on a trusted host / behind your network boundary.
 */
import { NextResponse, type NextRequest } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { alert } from "@/lib/alert";

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured → allow (dev)
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function sweep() {
  const svc = htlcService();
    const { forwardCounter, reverseMain, staleForwardMain, staleLoopSeller, loopCustodyStalled } = await svc.expiredOrders();
    const results: { id: string; kind: string; ok: boolean; detail: string }[] = [];
    const run = async (id: string, kind: string, fn: () => Promise<unknown>) => {
      try { const r = (await fn()) as { updateId?: string } | undefined; results.push({ id, kind, ok: true, detail: r?.updateId ?? "ok" }); }
      catch (e) {
        const detail = e instanceof Error ? e.message.slice(0, 120) : String(e);
        results.push({ id, kind, ok: false, detail });
        // A refund that's DUE but keeps failing = funds may be stuck → alert.
        void alert("error", "Auto-refund FAILED for an expired swap", { order: id.slice(0, 18), kind, detail });
      }
    };
    for (const o of forwardCounter) await run(o.id, "refund-counter", () => svc.refundCounter(o.id));
    for (const o of reverseMain) await run(o.id, "refund-main", () => svc.refundMainCanton(o.id));
    for (const o of staleForwardMain) await run(o.id, "mark-stale", () => svc.markRefunded(o.id));
    // Loop-seller custody (Variant A): WE hold the cBTC → send it straight back
    // (direct transfer, the user's preapproval auto-accepts). Fully automated.
    for (const o of staleLoopSeller) await run(o.id, "refund-loop-custody", () => svc.refundMainCanton(o.id));
    // EARLY custody return — stalled loop-seller swaps (no WBTC counter-lock within
    // grace). Verified safe on-chain inside the method (no WBTC lock must exist).
    for (const o of loopCustodyStalled) await run(o.id, "early-refund-loop", () => svc.earlyRefundLoopCustody(o.id));
    const due = forwardCounter.length + reverseMain.length + staleForwardMain.length + staleLoopSeller.length + loopCustodyStalled.length;
    return { due, refunded: results.filter((r) => r.ok).length, results };
}

export async function POST() {
  try { return NextResponse.json(await sweep()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json(await sweep()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
