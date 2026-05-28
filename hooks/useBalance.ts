"use client";

import { useEffect, useState } from "react";

import { NETWORK } from "@/lib/constants";
import { sumBtc } from "@/lib/format";
import type { Holding } from "@/lib/types";
import { useWallet } from "./useWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded). */
  total: string;
  /** Locked portion of the balance (cBTC tied up in pending transfers). */
  locked: string;
  /** Number of on-ledger cBTC Holding contracts for this party. */
  utxoCount: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

interface Fetched {
  total: string;
  locked: string;
  utxoCount: number;
}

const ZERO: Fetched = { total: "0", locked: "0", utxoCount: 0 };

/** How often to re-fetch the balance in the background (ms). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Fetch cBTC holdings from the server route GET /api/canton/holdings.
 * The server route uses the m2m JWT (WarpX party authority) — no Loop SDK needed.
 * Returns { total, locked, utxoCount } in BTC decimal strings.
 *
 * Polls every 30s while the tab is visible so the UI reflects on-ledger changes
 * (e.g. cron-driven mint processor pushing cBTC to the user's party) without
 * a manual refresh. Pauses polling when the tab is hidden to save resources.
 */
export function useBalance(): BalanceState {
  const { partyId } = useWallet();

  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!partyId) return;

    let cancelled = false;
    // Only show the loading state on the first fetch — subsequent background
    // polls should refresh silently so we don't flash a spinner every 30s.
    const isInitial = fetched === null;
    if (isInitial) setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(
          `/api/canton/holdings?partyId=${encodeURIComponent(partyId)}`,
        );
        const data = (await res.json()) as {
          holdings?: Holding[];
          error?: string;
        };

        if (!res.ok) {
          throw new Error(data.error ?? `Holdings fetch failed (${res.status})`);
        }

        if (cancelled) return;

        const holdings = data.holdings ?? [];

        // Filter to cBTC only (guard against other instruments on the same party).
        const cbtcHoldings = holdings.filter(
          (h) =>
            h.payload.instrumentId.id === NETWORK.instrumentId.id &&
            h.payload.instrumentId.admin === NETWORK.instrumentId.admin,
        );

        // Separate locked (lock field present and non-null) from unlocked.
        const unlocked = cbtcHoldings.filter(
          (h) => h.payload.lock === null || h.payload.lock === undefined,
        );
        const locked = cbtcHoldings.filter(
          (h) => h.payload.lock !== null && h.payload.lock !== undefined,
        );

        const totalBtc = sumBtc(unlocked.map((h) => h.payload.amount ?? "0"));
        const lockedBtc = sumBtc(locked.map((h) => h.payload.amount ?? "0"));

        setFetched({
          total: totalBtc,
          locked: lockedBtc,
          utxoCount: cbtcHoldings.length,
        });
        if (isInitial) setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        if (isInitial) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `fetched` is intentionally omitted to avoid an infinite loop — we read it
    // inside the effect only to detect the initial fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, tick]);

  // Background polling: re-fetch every POLL_INTERVAL_MS while the tab is
  // visible. We pause when the tab is hidden so a backgrounded tab doesn't
  // hammer the ledger API.
  useEffect(() => {
    if (!partyId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(() => setTick((n) => n + 1), POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // Refetch immediately on return so the user sees fresh data right away.
        setTick((n) => n + 1);
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [partyId]);

  const view = fetched ?? ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    isLoading,
    error,
    refetch: () => setTick((n) => n + 1),
  };
}
