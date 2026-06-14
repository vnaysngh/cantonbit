/**
 * POST/GET /api/htlc/auto-refund — the expiry sweep, BOTH directions. Runs from
 * TWO triggers so refunds survive even if the daemon is down:
 *   - the solver daemon's 60s timer (POST), and
 *   - a scheduled cron (GET — Vercel cron / external worker, Bearer CRON_SECRET).
 * Idempotent per order. Covers forward/reverse CBTC refunds + Loop custody returns.
 *
 * AUTH: production requires daemon/cron bearer authorization. Development allows
 * local sweeps without a secret so the worker remains easy to run locally.
 */
import { NextResponse, type NextRequest } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { alert } from "@/lib/alert";
import { requireDaemon } from "@/lib/htlc-auth";

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // not configured → allow only in dev
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function sweep() {
  const svc = htlcService();
  const {
    forwardCounter,
    reverseMain,
    staleForwardMain,
    staleLoopSeller,
    loopCustodyStalled
  } = await svc.expiredOrders();
  const results: { id: string; kind: string; ok: boolean; detail: string }[] =
    [];
  const run = async (id: string, kind: string, fn: () => Promise<unknown>) => {
    try {
      const r = (await fn()) as { updateId?: string } | undefined;
      results.push({ id, kind, ok: true, detail: r?.updateId ?? "ok" });
    } catch (e) {
      const detail = e instanceof Error ? e.message.slice(0, 120) : String(e);
      results.push({ id, kind, ok: false, detail });
      void alert("error", "Auto-refund FAILED for an expired swap", {
        order: id.slice(0, 18),
        kind,
        detail
      });
    }
  };
  for (const o of forwardCounter)
    await run(o.id, "refund-counter", () => svc.refundCounter(o.id));
  for (const o of reverseMain)
    await run(o.id, "refund-main", () => svc.refundMainCanton(o.id));
  for (const o of staleForwardMain)
    await run(o.id, "mark-stale", () => svc.markRefunded(o.id));
  for (const o of staleLoopSeller)
    await run(o.id, "refund-loop-custody", () => svc.refundMainCanton(o.id));
  for (const o of loopCustodyStalled)
    await run(o.id, "early-refund-loop", () =>
      svc.earlyRefundLoopCustody(o.id)
    );
  const due =
    forwardCounter.length +
    reverseMain.length +
    staleForwardMain.length +
    staleLoopSeller.length +
    loopCustodyStalled.length;
  return { due, refunded: results.filter((r) => r.ok).length, results };
}

export async function POST(req: Request) {
  const auth = requireDaemon(req);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await sweep());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await sweep());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
