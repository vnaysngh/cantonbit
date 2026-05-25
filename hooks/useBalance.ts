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

/**
 * Fetch cBTC holdings from the server route GET /api/canton/holdings.
 * The server route uses the m2m JWT (WarpX party authority) — no Loop SDK needed.
 * Returns { total, locked, utxoCount } in BTC decimal strings.
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
    setIsLoading(true);
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
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [partyId, tick]);

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
