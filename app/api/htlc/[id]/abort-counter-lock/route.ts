import { NextResponse } from "next/server";

import { requireDaemon } from "@/lib/htlc-auth";
import { htlcService } from "@/lib/htlc-service-singleton";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const { id } = await params;
    const order = await htlcService().abortCounterLock(id);
    return NextResponse.json({ order });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 409 }
    );
  }
}
