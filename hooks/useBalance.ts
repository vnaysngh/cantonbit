"use client";

import { useQuery } from "@tanstack/react-query";

import { balanceQueryKey } from "@/lib/balance-query";
import { readLoopCbtcBalance, readLoopCcBalance } from "@/lib/loop-holdings";
import { useCantonIdentity } from "./useCantonIdentity";
import { useLoopWallet } from "./useLoopWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded). */
  total: string;
  /** Locked portion of the balance (CBTC tied up in pending transfers). */
  locked: string;
  /** Number of CBTC holdings (Loop aggregates per-instrument, so 0 or 1). */
  utxoCount: number;
  /** CC (Amulet) balance — Loop: client-side holdings; email: /api/parties/balance. */
  ccTotal: string | null;
  /** True when ccTotal >= MIN_CC_BALANCE (server-side). */
  ccReady: boolean | null;
  /** Devnet: operator may cover fees even when ccReady is false. */
  ccSubsidizedOnDevnet: boolean;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

interface Fetched {
  total: string;
  locked: string;
  utxoCount: number;
  ccTotal: string | null;
  ccReady: boolean | null;
  ccSubsidizedOnDevnet: boolean;
}

const ZERO: Fetched = {
  total: "0",
  locked: "0",
  utxoCount: 0,
  ccTotal: null,
  ccReady: null,
  ccSubsidizedOnDevnet: false
};

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
  const { isManaged, party: identityParty, ready: identityReady } =
    useCantonIdentity();
  const { provider, connected, party: loopParty } = useLoopWallet();

  // Match /swap: use Loop SDK when the wallet is connected; only fall back to the
  // server ledger read for participant-managed (email) users with no Loop provider.
  const useLoopPath = connected && !!provider && !isManaged;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: balanceQueryKey(
      useLoopPath ? loopParty : (identityParty ?? "session")
    ),
    enabled: identityReady && (useLoopPath ? !!provider : true),
    queryFn: async (): Promise<Fetched> => {
      if (useLoopPath && provider) {
        const [{ total, locked, count }, ccTotal] = await Promise.all([
          readLoopCbtcBalance(provider),
          readLoopCcBalance(provider)
        ]);
        return {
          total,
          locked,
          utxoCount: count,
          ccTotal,
          ccReady: null,
          ccSubsidizedOnDevnet: false
        };
      }
      // Session-party (email) path — server reads the warpx party's holdings.
      const r = await fetch("/api/parties/balance");
      if (!r.ok) {
        return { ...ZERO, ccTotal: "0", ccReady: false };
      }
      const j = (await r.json()) as {
        total?: string;
        utxoCount?: number;
        ccTotal?: string;
        ccReady?: boolean;
        ccSubsidizedOnDevnet?: boolean;
      };
      return {
        total: j.total ?? "0",
        locked: "0",
        utxoCount: j.utxoCount ?? 0,
        ccTotal: j.ccTotal ?? "0",
        ccReady: j.ccReady ?? false,
        ccSubsidizedOnDevnet: j.ccSubsidizedOnDevnet ?? false
      };
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnMount: "always"
  });

  const view = data ?? ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    ccTotal: view.ccTotal ?? (isLoading ? null : "0"),
    ccReady: view.ccReady,
    ccSubsidizedOnDevnet: view.ccSubsidizedOnDevnet,
    isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch()
  };
}
