import { toBaseUnits } from "./amount-units";

/** MVP per-swap caps (pay leg). */
export const MAX_SWAP_CC = "200";
export const MAX_SWAP_CBTC = "0.0001";

export type SwapPayAsset = "CC" | "CBTC" | "WBTC";

const CC_DECIMALS = 10;
const BTC_DECIMALS = 8;

export function swapPayAmountLimitUnits(asset: SwapPayAsset): bigint {
  if (asset === "CC") return toBaseUnits(MAX_SWAP_CC, CC_DECIMALS);
  return toBaseUnits(MAX_SWAP_CBTC, BTC_DECIMALS);
}

export function swapPayAmountLimitMessage(asset: SwapPayAsset): string {
  if (asset === "CC") return `Max ${MAX_SWAP_CC} CC per swap`;
  if (asset === "WBTC") return `Max ${MAX_SWAP_CBTC} WBTC per swap`;
  return `Max ${MAX_SWAP_CBTC} CBTC per swap`;
}

export function checkSwapPayAmountLimit(
  asset: SwapPayAsset,
  amount: string
): { ok: true } | { ok: false; message: string } {
  try {
    const decimals = asset === "CC" ? CC_DECIMALS : BTC_DECIMALS;
    const units = toBaseUnits(amount.trim(), decimals);
    if (units <= 0n) return { ok: true };
    if (units > swapPayAmountLimitUnits(asset)) {
      return { ok: false, message: swapPayAmountLimitMessage(asset) };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Map Canton swap leg token or HTLC pay token to a capped asset id. */
export function swapPayAssetFromToken(token: string): SwapPayAsset | null {
  if (token === "CC") return "CC";
  if (token === "CBTC") return "CBTC";
  if (token === "WBTC") return "WBTC";
  return null;
}
