/**
 * GET /api/htlc/{id} — fetch a swap order's status (drives the UI timeline).
 */
import { NextResponse } from "next/server";
import { requireOrderOwnerOrDaemon } from "@/lib/htlc-auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwnerOrDaemon(req, id);
    if (auth.error) return auth.error;
    const order = auth.order;
    return NextResponse.json({
      order:
        order.counterMode === "loop"
          ? { ...order, networkFeeCc: undefined }
          : order
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
