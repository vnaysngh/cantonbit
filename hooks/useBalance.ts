"use client";

import { useQuery } from "@tanstack/react-query";

import { readLoopCbtcBalance } from "@/lib/loop-holdings";
import { useLoopWallet } from "./useLoopWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded). */
  total: string;
  /** Locked portion of the balance (CBTC tied up in pending transfers). */
  locked: string;
  /** Number of CBTC holdings (Loop aggregates per-instrument, so 0 or 1). */
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
 * Fetch the user's CBTC balance.
 *  - LOOP user: read their OWN holdings via provider.getHolding() (the m2m JWT
 *    can't read a Loop party hosted on another participant).
 *  - PARTICIPANT-MANAGED (email) user: no Loop provider, so read the session
 *    party's on-ledger holdings server-side via /api/parties/balance (the m2m JWT
 *    CAN read warpx-hosted parties). This is why a managed user's real CBTC used
 *    to show 0.
 */
export function useBalance(): BalanceState {
  const { provider, connected, party } = useLoopWallet();
  const useLoop = connected && !!provider;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["balance", useLoop ? party : "session"],
    queryFn: async (): Promise<Fetched> => {
      if (useLoop && provider) {
        const { total, locked, count } = await readLoopCbtcBalance(provider);
        return { total, locked, utxoCount: count };
      }
      // Session-party (email) path — server reads the warpx party's holdings.
      const r = await fetch("/api/parties/balance");
      if (!r.ok) return ZERO;
      const j = (await r.json()) as { total?: string; utxoCount?: number };
      return {
        total: j.total ?? "0",
        locked: "0",
        utxoCount: j.utxoCount ?? 0
      };
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false
  });

  const view = data ?? ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch()
  };
}
