/** GET /api/htlc/active — non-terminal orders the solver daemon should act on. */
import { NextResponse } from "next/server";
import { htlcService } from "@/lib/htlc-service-singleton";
import { requireDaemon } from "@/lib/htlc-auth";
import { htlcCanExposePreimageToSolver } from "@/lib/swap-product-invariants";
import { assertEnabledHtlcChain } from "@/lib/swap-evm";

export async function GET(req: Request) {
  try {
    const auth = requireDaemon(req);
    if (auth.error) return auth.error;
    const url = new URL(req.url);
    const chainHeader = req.headers.get("x-warpx-evm-chain");
    const chainParam = url.searchParams.get("evmChain");
    const chain = chainHeader || chainParam;
    if (!chain?.trim()) {
      return NextResponse.json(
        { error: "missing daemon EVM chain" },
        { status: 400 }
      );
    }
    const chainSlug = assertEnabledHtlcChain(chain).slug;
    const orders = (await htlcService().activeOrders(chainSlug)).map((order) => {
      if (
        order.direction === "evm-to-canton" &&
        !htlcCanExposePreimageToSolver(order).ok
      ) {
        return { ...order, revealedPreimage: undefined };
      }
      return order;
    });
    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
