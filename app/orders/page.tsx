"use client";

/**
 * /orders — swap history for the logged-in user (both directions).
 * Identity: email session (server resolves the warpx party from the cookie) or
 * the connected Loop wallet (party passed as a query param). Newest first.
 */
import { useEffect, useState } from "react";

import { useWallet } from "@/hooks/useWallet";
import { SWAP_CHAIN } from "@/lib/swap-evm";
import { cn } from "@/lib/utils";

interface HistoryOrder {
  id: string;
  direction: "evm-to-canton" | "canton-to-evm";
  status: string;
  wbtcAmount: string;   // 8dp base units
  cbtcAmount: string;   // decimal string
  mainLockTx?: string;
  counterLockTx?: string;
  mainClaimTx?: string;
  createdAt: number;    // unix seconds
  counterMode?: string;
}

const STATUS_STYLE: Record<string, string> = {
  main_claimed: "bg-green-500/15 text-green-600",
  counter_claimed: "bg-amber-500/15 text-amber-600",
  counter_locked: "bg-blue-500/15 text-blue-600",
  main_locked: "bg-blue-500/15 text-blue-600",
  refunded: "bg-foreground/10 text-foreground/60",
  cancelled: "bg-foreground/10 text-foreground/60",
  failed: "bg-red-500/15 text-red-600",
};
const STATUS_LABEL: Record<string, string> = {
  open: "Open", accepted: "Accepted", main_locked: "Locking",
  counter_locked: "Claimable", counter_claimed: "Settling",
  main_claimed: "Completed", refunded: "Refunded",
  cancelled: "Cancelled", failed: "Failed",
};

function fmtWbtc(units: string): string {
  try { return (Number(BigInt(units)) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""); }
  catch { return units; }
}
function fmtCbtc(dec: string): string {
  const n = parseFloat(dec); return Number.isFinite(n) ? n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : dec;
}

export default function OrdersPage() {
  const wallet = useWallet();
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (wallet.isLoading) return; // wait for Loop session restore (avoids an empty flash)
    let alive = true;
    const qs = wallet.partyId ? `?party=${encodeURIComponent(wallet.partyId)}` : "";
    fetch(`/api/htlc/history${qs}`)
      .then((r) => r.json())
      .then((d) => { if (alive) d.error ? setError(d.error) : setOrders(d.orders ?? []); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [wallet.isLoading, wallet.partyId]);

  const explorer = SWAP_CHAIN.blockExplorerUrls?.[0] ?? "";

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-6 sm:py-10">
      <h1 className="mb-4 px-1 text-2xl font-semibold text-foreground">Orders</h1>

      <div className="rounded-3xl border border-foreground/10 bg-card p-2 shadow-sm sm:p-3">
        {!orders && !error && (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70" />
          </div>
        )}
        {error && <p className="px-3 py-8 text-center text-sm text-red-500">⚠️ {error}</p>}
        {orders && orders.length === 0 && (
          <p className="px-3 py-10 text-center text-sm text-foreground/60">
            No swaps yet — your completed and pending swaps will appear here.
          </p>
        )}
        {orders && orders.length > 0 && (
          <ul className="divide-y divide-foreground/5">
            {orders.map((o) => {
              const reverse = o.direction === "canton-to-evm";
              const pay = reverse ? `${fmtCbtc(o.cbtcAmount)} CBTC` : `${fmtWbtc(o.wbtcAmount)} WBTC`;
              const recv = reverse ? `${fmtWbtc(o.wbtcAmount)} WBTC` : `${fmtCbtc(o.cbtcAmount)} CBTC`;
              const evmTx = reverse ? o.counterLockTx : o.mainLockTx;
              const date = o.createdAt ? new Date(o.createdAt * 1000).toLocaleString() : "";
              return (
                <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-3">
                  <div className="min-w-[190px] flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {pay} <span className="text-foreground/40">→</span> {recv}
                    </div>
                    <div className="mt-0.5 text-xs text-foreground/50">
                      {date} · <span className="font-mono">{o.id.slice(0, 12)}…</span>
                      {evmTx && evmTx.startsWith("0x") && explorer && (
                        <>
                          {" · "}
                          <a className="underline hover:text-foreground" target="_blank" rel="noopener noreferrer"
                             href={`${explorer}/tx/${evmTx}`}>
                            EVM tx ↗
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <span className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium",
                    STATUS_STYLE[o.status] ?? "bg-foreground/10 text-foreground/60",
                  )}>
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
