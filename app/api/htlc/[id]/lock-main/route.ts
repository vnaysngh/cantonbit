/**
 * POST /api/htlc/{id}/lock-main — REVERSE (canton-to-evm) step 2: the backend locks
 * the USER's cBTC on-ledger (Allocation sender=user + HtlcLock locker=user, LONG
 * timelock) via CanActAs — Cancore's "platform auto-locks". Managed users only.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireOrderOwner } from "@/lib/htlc-auth";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwner(id);
    if (auth.error) return auth.error;
    const order = await htlcService().lockMainCanton(id);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
