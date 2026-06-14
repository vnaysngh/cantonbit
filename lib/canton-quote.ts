/**
 * Same-Canton HTLC quotes — Tradecraft AMM (single upstream call).
 */
import "server-only";

import { fromBaseUnits, toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import {
  getSwapAsset,
  isCantonPair,
  type CantonSwapAssetId
} from "./canton-assets";
import { assertCantonQuoteSanity } from "./canton-quote-sanity";
import {
  tradecraftQuoteFixedInput,
  TradecraftQuoteError
} from "./canton-price-tradecraft";
import { applyOutputFee } from "./htlc-quote-math";
import { BRIDGE_FEE_BPS, QUOTE_TTL_SECONDS } from "./htlc-quote";

export class CantonQuoteUnavailableError extends Error {}
export class CantonQuoteSanityError extends Error {}

export interface CantonQuoteResult {
  fromAsset: CantonSwapAssetId;
  toAsset: CantonSwapAssetId;
  inUnits: bigint;
  outUnits: bigint;
  feeBps: number;
  expiresAt: number;
  source: "tradecraft";
}

export async function quoteCantonToCanton(
  fromAsset: CantonSwapAssetId,
  toAsset: CantonSwapAssetId,
  inUnits: bigint
): Promise<CantonQuoteResult> {
  if (!isCantonPair(fromAsset, toAsset)) {
    throw new Error(`unsupported pair ${fromAsset}/${toAsset}`);
  }
  if (inUnits <= 0n) throw new Error("amount must be > 0");

  const from = getSwapAsset(fromAsset);
  const to = getSwapAsset(toAsset);
  const inDec = fromBaseUnits(inUnits, from.decimals);

  let gross: bigint;
  try {
    const userGets = await tradecraftQuoteFixedInput({
      from: fromAsset,
      to: toAsset,
      givingAmount: inDec
    });
    gross = toBaseUnitsFloor(
      userGets.toFixed(Math.min(18, to.decimals + 8)),
      to.decimals
    );
  } catch (e) {
    if (e instanceof TradecraftQuoteError) {
      throw new CantonQuoteUnavailableError(e.message);
    }
    throw e;
  }

  if (gross <= 0n) {
    throw new Error("quote output must be > 0");
  }

  await assertCantonQuoteSanity(fromAsset, toAsset, inUnits, gross);

  const outUnits = applyOutputFee(gross, BRIDGE_FEE_BPS);
  if (outUnits <= 0n) {
    throw new Error("quote output must be > 0 after fee");
  }

  return {
    fromAsset,
    toAsset,
    inUnits,
    outUnits,
    feeBps: BRIDGE_FEE_BPS,
    expiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS,
    source: "tradecraft"
  };
}

const ORDER_AMOUNT_TOLERANCE_BPS = 30;

/** Max adverse price move tolerated at settlement vs order outAmount. */
export const SETTLEMENT_SLIPPAGE_BPS = 50;

export async function assertOrderAmountsCantonToCanton(
  fromAsset: CantonSwapAssetId,
  toAsset: CantonSwapAssetId,
  inUnits: bigint,
  claimedOutUnits: bigint
): Promise<void> {
  const fresh = await quoteCantonToCanton(fromAsset, toAsset, inUnits);
  const maxOut =
    fresh.outUnits +
    (fresh.outUnits * BigInt(ORDER_AMOUNT_TOLERANCE_BPS)) / 10000n;
  if (claimedOutUnits > maxOut) {
    throw new Error(
      `order output ${claimedOutUnits} exceeds fresh quote ${fresh.outUnits} (+${ORDER_AMOUNT_TOLERANCE_BPS}bps)`
    );
  }
}
