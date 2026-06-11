/** GET /api/htlc/active — non-terminal orders the solver daemon should act on. */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function GET() {
  try {
    const orders = await htlcService().activeOrders();
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
