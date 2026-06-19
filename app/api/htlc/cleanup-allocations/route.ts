/**
 * POST /api/htlc/cleanup-allocations — withdraw the solver's orphaned Allocations
 * (CBTC locked by a failed/retried lock that has no HtlcLock). Returns the CBTC to
 * the solver via Allocation_Withdraw (sender-alone, safe). Admin/cleanup only.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { listSolverAllocations, withdrawAllocation } from "@/lib/htlc-onledger";
import { expectedSettlementParty, requireDaemon } from "@/lib/htlc-auth";

export async function POST(req: Request) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const vault = expectedSettlementParty();
    if (!vault) {
      return NextResponse.json(
        { error: "CANTON_SWAP_SETTLEMENT_PARTY not configured" },
        { status: 503 }
      );
    }
    const allocs = await listSolverAllocations(vault);
    const active = await htlcService().activeOrders();
    const referenced = new Set(
      active.map((o) => o.allocationCid).filter(Boolean)
    );
    const orphaned = allocs.filter((cid) => !referenced.has(cid));
    const results: { allocationCid: string; ok: boolean; detail: string }[] =
      [];
    for (const cid of orphaned) {
      try {
        const { updateId } = await withdrawAllocation(vault, cid);
        results.push({ allocationCid: cid, ok: true, detail: updateId });
      } catch (e) {
        results.push({
          allocationCid: cid,
          ok: false,
          detail: e instanceof Error ? e.message.slice(0, 120) : String(e)
        });
      }
    }
    return NextResponse.json({
      found: allocs.length,
      skippedActive: allocs.length - orphaned.length,
      withdrawn: results.filter((r) => r.ok).length,
      results
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
