"use client";

import { useQuery } from "@tanstack/react-query";

import { NETWORK } from "@/lib/constants";
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

/** Shape of a Loop SDK Holding (see @fivenorth/loop-sdk types). */
interface LoopHolding {
  instrument_id: { admin: string; id: string };
  decimals: number;
  symbol: string;
  total_unlocked_coin: string;
  total_locked_coin: string;
}

/**
 * Fetch the user's cBTC balance from their CONNECTED LOOP WALLET via
 * provider.getHolding(). This reads the user's OWN holdings through their Loop
 * connection — the correct source, since the app's m2m JWT cannot read a Loop
 * party hosted on another participant.
 *
 * Loop returns per-instrument aggregates (total_unlocked_coin / total_locked_coin
 * as decimal BTC strings), so there's no UTXO enumeration to sum.
 */
export function useBalance(): BalanceState {
  const { provider, connected, party } = useLoopWallet();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["balance", party],
    enabled: connected && !!provider,
    queryFn: async (): Promise<Fetched> => {
      if (!provider) return ZERO;
      const holdings = (await provider.getHolding()) as unknown as LoopHolding[];
      // Keep only the cBTC instrument for this network.
      const cbtc = holdings.filter(
        (h) =>
          h.instrument_id?.id === NETWORK.instrumentId.id &&
          h.instrument_id?.admin === NETWORK.instrumentId.admin,
      );
      if (cbtc.length === 0) return ZERO;
      // Sum across instruments (normally one cBTC entry).
      const total = sumDecimals(cbtc.map((h) => h.total_unlocked_coin ?? "0"));
      const locked = sumDecimals(cbtc.map((h) => h.total_locked_coin ?? "0"));
      return { total, locked, utxoCount: cbtc.length };
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

/** Sum decimal BTC strings without floating-point drift (8dp fixed). */
function sumDecimals(values: string[]): string {
  let sats = 0n;
  for (const v of values) sats += toSats(v);
  return fromSats(sats);
}

function toSats(btc: string): bigint {
  const s = (btc ?? "0").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * 100_000_000n + BigInt(fracPadded || "0");
}

function fromSats(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
