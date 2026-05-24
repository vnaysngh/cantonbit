"use client";

import { useEffect, useState } from "react";

import { NETWORK } from "@/lib/constants";
import { sumBtc } from "@/lib/format";
import { useWallet } from "./useWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded or while disconnected). */
  total: string;
  /** Locked portion of the balance (cBTC tied up in pending transfers etc.). */
  locked: string;
  /** Number of on-ledger Holding contracts. -1 means "unknown / not loaded yet". */
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

const HOLDING_INTERFACE_ID =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

const ZERO: Fetched = { total: "0", locked: "0", utxoCount: -1 };

export function useBalance(): BalanceState {
  const { isConnected, provider } = useWallet();

  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isConnected || !provider) return;

    let cancelled = false;
    // The mock-era pattern: real-data fetch happens in an effect because
    // the Loop provider is a runtime singleton tied to the browser. When
    // we migrate to React 19 server actions for these calls, this whole
    // block goes away.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const [holdings, contracts] = await Promise.all([
          provider.getHolding(),
          provider.getActiveContracts({ interfaceId: HOLDING_INTERFACE_ID }),
        ]);
        if (cancelled) return;

        const cbtc = holdings.find(
          (h) =>
            h.instrument_id.id === NETWORK.instrumentId.id &&
            h.instrument_id.admin === NETWORK.instrumentId.admin,
        );

        setFetched({
          total: sumBtc([cbtc?.total_unlocked_coin ?? "0"]),
          locked: sumBtc([cbtc?.total_locked_coin ?? "0"]),
          utxoCount: contracts.length,
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
  }, [isConnected, provider, tick]);

  // Derive the public surface from isConnected + fetched, so disconnected
  // state needs no setState calls inside the effect.
  const view = isConnected && fetched ? fetched : ZERO;

  return {
    total: view.total,
    locked: view.locked,
    utxoCount: view.utxoCount,
    isLoading: isConnected && isLoading,
    error: isConnected ? error : null,
    refetch: () => setTick((n) => n + 1),
  };
}
