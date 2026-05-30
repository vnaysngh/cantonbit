"use client";

import { useQuery } from "@tanstack/react-query";

import { NETWORK } from "@/lib/constants";
import { sumBtc } from "@/lib/format";
import type { Holding } from "@/lib/types";
import { useWallet } from "./useWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded). */
  total: string;
  /** Locked portion of the balance (CBTC tied up in pending transfers). */
  locked: string;
  /** Number of on-ledger CBTC Holding contracts for this party. */
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
 * Fetch CBTC holdings from the server route GET /api/canton/holdings.
 * The server route uses the m2m JWT (WarpX party authority) — no Loop SDK needed.
 * Returns { total, locked, utxoCount } in BTC decimal strings.
 *
 * Backed by React Query — handles caching, stale-while-revalidate, and
 * visibility-aware polling automatically (pauses when the tab is hidden).
 */
export function useBalance(): BalanceState {
  const { partyId } = useWallet();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["balance", partyId],
    enabled: !!partyId,
    queryFn: async (): Promise<Fetched> => {
      const res = await fetch(
        `/api/canton/holdings?partyId=${encodeURIComponent(partyId!)}`,
      );
      const json = (await res.json()) as {
        holdings?: Holding[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error ?? `Holdings fetch failed (${res.status})`);
      }

      const holdings = json.holdings ?? [];
      // Filter to CBTC only (guard against other instruments on the same party).
      const cbtcHoldings = holdings.filter(
        (h) =>
          h.payload.instrumentId.id === NETWORK.instrumentId.id &&
          h.payload.instrumentId.admin === NETWORK.instrumentId.admin,
      );
      const unlocked = cbtcHoldings.filter(
        (h) => h.payload.lock === null || h.payload.lock === undefined,
      );
      const locked = cbtcHoldings.filter(
        (h) => h.payload.lock !== null && h.payload.lock !== undefined,
      );
      return {
        total: sumBtc(unlocked.map((h) => h.payload.amount ?? "0")),
        locked: sumBtc(locked.map((h) => h.payload.amount ?? "0")),
        utxoCount: cbtcHoldings.length,
      };
    },
    // Pauses automatically when the tab is hidden.
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const view = data ?? ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch(),
  };
}
