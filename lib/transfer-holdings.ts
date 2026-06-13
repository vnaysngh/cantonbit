import type { Holding } from "./types";
import { formatSatoshis } from "./format";

/**
 * Select holdings to cover `amount` (BTC string).
 * Greedy smallest-first — keeps UTXO hygiene and avoids large registrar holdings.
 */
export function selectTransferHoldings(
  holdings: Holding[],
  amountBtc: string,
  assetSymbol = "CBTC"
): Holding[] {
  const target = BigInt(Math.round(parseFloat(amountBtc) * 1e8));
  const sorted = [...holdings].sort((a, b) => {
    const aSats = BigInt(Math.round(parseFloat(a.payload.amount ?? "0") * 1e8));
    const bSats = BigInt(Math.round(parseFloat(b.payload.amount ?? "0") * 1e8));
    if (aSats > bSats) return 1;
    if (aSats < bSats) return -1;
    return 0;
  });
  const picked: Holding[] = [];
  let acc = 0n;
  for (const h of sorted) {
    if (acc >= target) break;
    picked.push(h);
    acc += BigInt(Math.round(parseFloat(h.payload.amount ?? "0") * 1e8));
  }
  if (acc < target) {
    throw new Error(
      `Insufficient balance: have ${formatSatoshis(acc)} ${assetSymbol}, need ${amountBtc} ${assetSymbol}`
    );
  }
  return picked;
}
