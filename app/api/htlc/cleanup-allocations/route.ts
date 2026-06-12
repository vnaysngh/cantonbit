/**
 * POST /api/htlc/cleanup-allocations — withdraw the solver's orphaned Allocations
 * (cBTC locked by a failed/retried lock that has no HtlcLock). Returns the cBTC to
 * the solver via Allocation_Withdraw (sender-alone, safe). Admin/cleanup only.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { listSolverAllocations, withdrawAllocation } from "@/lib/htlc-onledger";
import { requireDaemon } from "@/lib/htlc-auth";

const SOLVER = process.env.SOLVER_CANTON_PARTY
  ?? process.env.NEXT_PUBLIC_SOLVER_CANTON
  ?? "warpx-devnet-1::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

export async function POST(req: Request) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const allocs = await listSolverAllocations(SOLVER);
    const active = await htlcService().activeOrders();
    const referenced = new Set(active.map((o) => o.allocationCid).filter(Boolean));
    const orphaned = allocs.filter((cid) => !referenced.has(cid));
    const results: { allocationCid: string; ok: boolean; detail: string }[] = [];
    for (const cid of orphaned) {
      try {
        const { updateId } = await withdrawAllocation(SOLVER, cid);
        results.push({ allocationCid: cid, ok: true, detail: updateId });
      } catch (e) {
        results.push({ allocationCid: cid, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    return NextResponse.json({
      found: allocs.length,
      skippedActive: allocs.length - orphaned.length,
      withdrawn: results.filter((r) => r.ok).length,
      results,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
