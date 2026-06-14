/**
 * Select holdings to cover `amount` (decimal string).
 * Greedy smallest-first — keeps UTXO hygiene and avoids large registrar holdings.
 */
import { fromBaseUnits, toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import { CC_ASSET } from "./canton-assets";
import type { Holding } from "./types";

function decimalsForSymbol(assetSymbol: string): number {
  return assetSymbol === "CC" ? CC_ASSET.decimals : 8;
}

export function selectTransferHoldings(
  holdings: Holding[],
  amount: string,
  assetSymbol = "CBTC",
  decimals = decimalsForSymbol(assetSymbol)
): Holding[] {
  return selectHoldingsForAmount(holdings, amount, decimals, assetSymbol);
}

/** Pick unlocked holdings to cover a decimal amount at native precision. */
export function selectHoldingsForAmount(
  holdings: Holding[],
  amount: string,
  decimals: number,
  assetSymbol: string
): Holding[] {
  const target = toBaseUnits(amount, decimals);
  const sorted = [...holdings].sort((a, b) => {
    const aU = toBaseUnitsFloor(a.payload.amount ?? "0", decimals);
    const bU = toBaseUnitsFloor(b.payload.amount ?? "0", decimals);
    if (aU > bU) return 1;
    if (aU < bU) return -1;
    return 0;
  });
  const picked: Holding[] = [];
  let acc = 0n;
  for (const h of sorted) {
    if (acc >= target) break;
    picked.push(h);
    acc += toBaseUnitsFloor(h.payload.amount ?? "0", decimals);
  }
  if (acc < target) {
    const have = fromBaseUnits(acc, decimals);
    throw new Error(
      `Insufficient balance: have ${have} ${assetSymbol}, need ${amount} ${assetSymbol}`
    );
  }
  return picked;
}
