/**
 * GET /api/htlc/{id}/counter-lock-status
 *
 * Reverse HTLC claim preflight. Before the browser opens MetaMask for
 * claim(preimage), verify the solver's WBTC lock actually exists on the order's
 * bound EVM chain/escrow/token. This prevents wrong-chain/stale solver writes
 * from surfacing as a confusing wallet gas-estimation failure.
 */
import { NextResponse } from "next/server";

import { requireOrderOwnerOrDaemon } from "@/lib/htlc-auth";
import { readEvmLockMapping } from "@/lib/htlc-evm-counter-lock";
import { htlcService } from "@/lib/htlc-service-singleton";
import { chainConfigForOrder } from "@/lib/swap-evm";

function lower(v?: string | null): string {
  return (v ?? "").toLowerCase();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const auth = await requireOrderOwnerOrDaemon(req, id);
    if (auth.error) return auth.error;

    const order = await htlcService().getOrder(id, { mode: "light" });
    if (!order) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (order.direction !== "canton-to-evm") {
      return NextResponse.json(
        { ready: false, reason: "wrong_direction" },
        { status: 400 }
      );
    }

    const chain = chainConfigForOrder(order);
    if (!chain.escrow?.trim()) {
      return NextResponse.json({
        ready: false,
        reason: "escrow_not_configured",
        chainName: chain.name,
        chainSlug: chain.slug
      });
    }
    if (!chain.wbtc?.trim()) {
      return NextResponse.json({
        ready: false,
        reason: "wbtc_not_configured",
        chainName: chain.name,
        chainSlug: chain.slug
      });
    }

    const lock = await readEvmLockMapping(order.hashLock, {
      rpcUrl: chain.rpcUrls[0],
      escrowAddress: chain.escrow,
      chainName: chain.name,
      chainSlug: chain.slug
    });
    const expectedAmount = BigInt(order.wbtcAmount ?? "0");
    const amountOk = lock.amount >= expectedAmount;
    const tokenOk = lower(lock.tokenAddress) === lower(chain.wbtc);
    const receiverOk =
      !!order.userEvmAddress && lower(lock.receiver) === lower(order.userEvmAddress);

    const ready = lock.amount > 0n && amountOk && tokenOk && receiverOk;
    let reason: string | undefined;
    if (!lock.amount) reason = "lock_not_found";
    else if (!amountOk) reason = "amount_mismatch";
    else if (!tokenOk) reason = "token_mismatch";
    else if (!receiverOk) reason = "receiver_mismatch";

    return NextResponse.json({
      ready,
      reason,
      chainName: chain.name,
      chainSlug: chain.slug,
      escrow: chain.escrow,
      expected: {
        amount: order.wbtcAmount ?? null,
        token: chain.wbtc,
        receiver: order.userEvmAddress ?? null
      },
      lock: {
        unlockTime: lock.unlockTime,
        amount: lock.amount.toString(),
        token: lock.tokenAddress,
        receiver: lock.receiver
      }
    });
  } catch (e) {
    return NextResponse.json(
      {
        ready: false,
        reason: e instanceof Error ? e.message : String(e)
      }
    );
  }
}
