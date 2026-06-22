import "server-only";

import { fromBaseUnits, toBaseUnits } from "./amount-units";
import { getSwapAsset } from "./canton-assets";
import {
  assertOrderAmountsCantonToCanton,
  quoteCantonToCanton,
  SETTLEMENT_SLIPPAGE_BPS,
  type CantonQuoteResult
} from "./canton-quote";
import type { CantonSwapMvpAssetId } from "./canton-swap-types";

/** MVP same-Canton pairs: CBTC ↔ CC only. */
export function isMvpSwapPair(
  from: CantonSwapMvpAssetId,
  to: CantonSwapMvpAssetId
): boolean {
  return from !== to;
}

export async function quoteMvpCantonSwap(
  fromAsset: CantonSwapMvpAssetId,
  toAsset: CantonSwapMvpAssetId,
  inAmount: string
): Promise<
  CantonQuoteResult & {
    inAmount: string;
    grossOutAmount: string;
    outAmount: string;
  }
> {
  if (!isMvpSwapPair(fromAsset, toAsset)) {
    throw new Error(`unsupported pair ${fromAsset}/${toAsset}`);
  }
  const from = getSwapAsset(fromAsset);
  const to = getSwapAsset(toAsset);
  const inUnits = toBaseUnits(inAmount, from.decimals);
  const q = await quoteCantonToCanton(fromAsset, toAsset, inUnits);
  return {
    ...q,
    inAmount: fromBaseUnits(q.inUnits, from.decimals),
    grossOutAmount: fromBaseUnits(q.grossOutUnits, to.decimals),
    outAmount: fromBaseUnits(q.outUnits, to.decimals)
  };
}

export async function assertMvpOrderAmounts(
  fromAsset: CantonSwapMvpAssetId,
  toAsset: CantonSwapMvpAssetId,
  inAmount: string,
  claimedOutAmount: string
): Promise<void> {
  const from = getSwapAsset(fromAsset);
  const to = getSwapAsset(toAsset);
  const inUnits = toBaseUnits(inAmount, from.decimals);
  const outUnits = toBaseUnits(claimedOutAmount, to.decimals);
  await assertOrderAmountsCantonToCanton(fromAsset, toAsset, inUnits, outUnits);
}

/** Re-quote at settlement and enforce minOut + slippage floor vs promised outAmount. */
export async function assertSettlementQuoteFresh(params: {
  fromAsset: CantonSwapMvpAssetId;
  toAsset: CantonSwapMvpAssetId;
  inAmount: string;
  outAmount: string;
  minOut: string;
}): Promise<void> {
  const from = getSwapAsset(params.fromAsset);
  const to = getSwapAsset(params.toAsset);
  const inUnits = toBaseUnits(params.inAmount, from.decimals);
  const minOutUnits = toBaseUnits(params.minOut, to.decimals);
  const promisedOut = toBaseUnits(params.outAmount, to.decimals);

  const fresh = await quoteCantonToCanton(params.fromAsset, params.toAsset, inUnits);
  if (fresh.outUnits < minOutUnits) {
    throw new Error(
      `fresh quote ${fromBaseUnits(fresh.outUnits, to.decimals)} below minOut ${params.minOut}`
    );
  }
  const floor =
    promisedOut -
    (promisedOut * BigInt(SETTLEMENT_SLIPPAGE_BPS)) / 10000n;
  if (fresh.outUnits < floor) {
    throw new Error(
      `price moved: fresh quote ${fromBaseUnits(fresh.outUnits, to.decimals)} below settlement floor`
    );
  }
}
