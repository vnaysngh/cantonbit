"use client";

import { useEffect, useState } from "react";

import { getHealth, type HealthResponse } from "@/lib/swap-api";
import { formatWbtc } from "@/lib/swap-evm";

/**
 * Stats — live, HONEST bridge metrics. Every number here is sourced from the
 * solver's /health (real config + live cBTC float). We deliberately do NOT show
 * "total volume" / "# of swaps": the global GET /orders list was removed for
 * security (HIGH-4), so there is no trustworthy aggregate to display, and we
 * won't fabricate one. When an authenticated admin/analytics feed exists, this
 * page can grow real volume figures.
 */
export default function StatsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        setHealth(h);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not reach the bridge.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    // Refresh the live float every 30s.
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const float =
    health?.floatSats != null ? formatWbtc(BigInt(health.floatSats)) : null;
  const feePct = health?.feeBps != null ? `${health.feeBps / 100}%` : null;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-6 sm:py-10">
      <div className="mb-6 px-1">
        <h1 className="text-2xl font-semibold text-foreground">Stats</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live status of the WBTC → CBTC bridge.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-foreground/10 bg-muted/40"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <>
          {/* Status banner */}
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-foreground/10 bg-card p-4 shadow-sm">
            <span
              className={
                health?.depeg
                  ? "size-2.5 rounded-full bg-amber-500"
                  : "size-2.5 rounded-full bg-emerald-500"
              }
            />
            <span className="text-sm font-medium text-foreground">
              {health?.depeg ? "Swaps paused (price unstable)" : "Bridge online"}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {health?.network} · {health?.chain}
            </span>
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Stat
              label="Available liquidity"
              value={float != null ? `${float} CBTC` : "—"}
              hint="CBTC the bridge can deliver right now"
            />
            <Stat
              label="Bridge fee"
              value={feePct ?? "—"}
              hint="Applied to the CBTC you receive"
            />
            <Stat
              label="Rate"
              value="Live WBTC/BTC"
              hint="Quoted per-swap from the on-chain price feed"
            />
          </div>

          <p className="mt-6 px-1 text-xs text-muted-foreground">
            Liquidity refreshes every 30s. CBTC is redeemable 1:1 for BTC, so the
            rate tracks the live WBTC/BTC price minus the bridge fee.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-4 shadow-sm">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
