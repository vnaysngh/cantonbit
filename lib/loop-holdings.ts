/**
 * Helpers for reading the user's cBTC from their connected Loop wallet.
 *
 * The Loop SDK gives two views:
 *  - provider.getHolding()         → per-instrument AGGREGATE (unlocked/locked totals)
 *  - provider.getActiveContracts() → per-CONTRACT (each holding's contract_id)
 *
 * Balance display uses the aggregate; redeem (which must pick specific UTXOs to
 * burn) uses the per-contract view. Both filter to the network's cBTC instrument.
 */

import { NETWORK } from "@/lib/constants";

/** Aggregate holding shape from provider.getHolding(). */
export interface LoopHolding {
  instrument_id: { admin: string; id: string };
  decimals: number;
  symbol: string;
  total_unlocked_coin: string;
  total_locked_coin: string;
}

/** A single active contract from provider.getActiveContracts(). */
export interface LoopActiveContract {
  template_id: string;
  contract_id: string;
  [key: string]: unknown;
}

interface ProviderLike {
  getHolding: () => Promise<unknown[]>;
  getActiveContracts: (params?: { templateId?: string; interfaceId?: string }) => Promise<unknown[]>;
}

function isOurCbtc(h: LoopHolding): boolean {
  return (
    h.instrument_id?.id === NETWORK.instrumentId.id &&
    h.instrument_id?.admin === NETWORK.instrumentId.admin
  );
}

/** Unlocked + locked cBTC totals (BTC decimal strings) from the Loop aggregate. */
export async function readLoopCbtcBalance(
  provider: ProviderLike,
): Promise<{ total: string; locked: string; count: number }> {
  const all = (await provider.getHolding()) as unknown as LoopHolding[];
  const cbtc = all.filter(isOurCbtc);
  if (cbtc.length === 0) return { total: "0", locked: "0", count: 0 };
  const total = sumDecimals(cbtc.map((h) => h.total_unlocked_coin ?? "0"));
  const locked = sumDecimals(cbtc.map((h) => h.total_locked_coin ?? "0"));
  return { total, locked, count: cbtc.length };
}

/** Sum decimal BTC strings via integer sats (no float drift, 8dp). */
export function sumDecimals(values: string[]): string {
  let sats = 0n;
  for (const v of values) sats += btcToSats(v);
  return satsToBtc(sats);
}

export function btcToSats(btc: string): bigint {
  const s = (btc ?? "0").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * 100_000_000n + BigInt(fracPadded || "0");
}

export function satsToBtc(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
