/** GET /api/htlc/active — non-terminal orders the solver daemon should act on. */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";

export async function GET(req: Request) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const orders = await htlcService().activeOrders();
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
