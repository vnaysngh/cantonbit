"use client";

import { useEffect, useState } from "react";

import { NETWORK } from "@/lib/constants";
import { sumBtc } from "@/lib/format";
import { useWallet } from "./useWallet";

interface BalanceState {
  /** Decimal BTC string ("0" until loaded or while disconnected). */
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

/**
 * Holding interface ID — filters getActiveContracts to cBTC Holding contracts.
 * We use the interface rather than a concrete template so it works regardless
 * of which exact Holding implementation the cBTC package uses.
 */
const HOLDING_INTERFACE_ID =
  "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";

const ZERO: Fetched = { total: "0", locked: "0", utxoCount: 0 };

export function useBalance(): BalanceState {
  const { isConnected, partyId, provider } = useWallet();

  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isConnected || !provider || !partyId) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        /**
         * Two parallel Loop SDK calls:
         *
         * 1. provider.getHolding()
         *    → GET cantonloop.com/.../account/holding
         *    Returns Loop's pre-aggregated balance per instrument for this
         *    party. Used for total_unlocked_coin and total_locked_coin.
         *    Scoped to the connected party by the Loop session auth_token —
         *    no extra filtering needed.
         *
         * 2. provider.getActiveContracts({ interfaceId: HOLDING_INTERFACE_ID })
         *    → GET cantonloop.com/.../active-contracts?interfaceId=...
         *    Returns individual Holding contracts for this party.
         *    Used to count UTXOs (holdings). We additionally filter by
         *    partyId (owner) and by instrumentId to be explicit — defence
         *    against Loop returning contracts for other parties or instruments.
         */
        const [holdings, contracts] = await Promise.all([
          provider.getHolding(),
          provider.getActiveContracts({ interfaceId: HOLDING_INTERFACE_ID }),
        ]);
        if (cancelled) return;

        // provider.getHolding() is already scoped to this party + instrument.
        // Find our cBTC entry by matching both id and admin.
        const cbtc = holdings.find(
          (h) =>
            h.instrument_id.id === NETWORK.instrumentId.id &&
            h.instrument_id.admin === NETWORK.instrumentId.admin,
        );

        // Filter contracts to only this party's cBTC holdings.
        // The Loop auth_token already scopes results to this party, but we
        // filter defensively by owner field and instrument to ensure we only
        // count cBTC UTXOs, not other token holdings.
        const cbtcContracts = contracts.filter((c) => {
          const cAny = c as unknown as Record<string, unknown>;

          // Try to extract owner from wherever Loop puts it.
          const viewValue =
            (cAny.interface_views as Array<{ view_value?: Record<string, unknown> }> | undefined)?.[0]?.view_value ??
            (cAny.interfaceViews as Array<{ viewValue?: Record<string, unknown> }> | undefined)?.[0]?.viewValue ??
            (cAny.payload as Record<string, unknown> | undefined) ??
            cAny;

          const owner = (viewValue as Record<string, unknown>)?.owner;
          const instrId = (viewValue as Record<string, unknown>)?.instrumentId as
            | { admin?: string; id?: string }
            | undefined;

          const ownerMatch = !owner || owner === partyId;
          const instrMatch =
            !instrId ||
            (instrId.id === NETWORK.instrumentId.id &&
              instrId.admin === NETWORK.instrumentId.admin);

          return ownerMatch && instrMatch;
        });

        setFetched({
          total: sumBtc([cbtc?.total_unlocked_coin ?? "0"]),
          locked: sumBtc([cbtc?.total_locked_coin ?? "0"]),
          utxoCount: cbtcContracts.length,
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
  }, [isConnected, provider, partyId, tick]);

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
