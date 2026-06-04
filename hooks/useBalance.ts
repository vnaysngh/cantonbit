"use client";

import { useQuery } from "@tanstack/react-query";

import { readLoopCbtcBalance } from "@/lib/loop-holdings";
import { useLoopWallet } from "./useLoopWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded). */
  total: string;
  /** Locked portion of the balance (CBTC tied up in pending transfers). */
  locked: string;
  /** Number of cBTC holdings (Loop aggregates per-instrument, so 0 or 1). */
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
 * Fetch the user's cBTC balance from their CONNECTED LOOP WALLET via
 * provider.getHolding(). This reads the user's OWN holdings through their Loop
 * connection — the correct source, since the app's m2m JWT cannot read a Loop
 * party hosted on another participant.
 */
export function useBalance(): BalanceState {
  const { provider, connected, party } = useLoopWallet();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["balance", party],
    enabled: connected && !!provider,
    queryFn: async (): Promise<Fetched> => {
      if (!provider) return ZERO;
      const { total, locked, count } = await readLoopCbtcBalance(provider);
      return { total, locked, utxoCount: count };
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const view = data ?? ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    isLoading: connected && isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch(),
  };
}
