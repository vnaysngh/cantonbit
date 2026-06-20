/**
 * POST /api/htlc/{id}/main-lock — record the maker's EVM HTLC lock (step 3).
 * Body: { mainLockTx }. The frontend submits the lock via MetaMask, then calls
 * this. The solver should verify the on-chain lock before locking the counter.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const { mainLockTx } = await req.json();
    if (!mainLockTx) return NextResponse.json({ error: "missing mainLockTx" }, { status: 400 });
    const svc = htlcService();
    const order = await svc.recordMainLock(id, mainLockTx);
    // Managed forward: start CBTC counter-lock immediately — do not wait for the
    // solver daemon poll queue (32+ stale orders + reverse watchtower scans).
    if (order.direction === "evm-to-canton" && order.counterMode === "managed") {
      void svc
        .lockCounter(id)
        .then(() =>
          console.log(`[htlc] eager lockCounter ok ${id.slice(0, 12)}…`)
        )
        .catch((e) =>
          console.error(
            `[htlc] eager lockCounter failed ${id.slice(0, 12)}…:`,
            e instanceof Error ? e.message : e
          )
        );
    }
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
