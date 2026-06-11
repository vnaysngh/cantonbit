/**
 * POST /api/htlc/{id}/cancel — the maker cancels an order before any HTLC locks.
 * Cancore parity: no on-chain activity; only valid while open/accepted.
 */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const order = await htlcService().cancel(id);
    return NextResponse.json({ ok: true, status: order.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
