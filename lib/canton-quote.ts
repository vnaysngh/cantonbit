/**
 * Same-Canton (C2C) quotes — Tradecraft AMM only.
 * Cross-chain HTLC pricing lives in lib/htlc-quote.ts (WBTC/BTC peg).
 */
import "server-only";

import { fromBaseUnits, toBaseUnitsFloor } from "./amount-units";
import {
  getSwapAsset,
  isCantonPair,
  type CantonSwapAssetId
} from "./canton-assets";
import {
  tradecraftQuoteFixedInputWithMeta,
  TradecraftQuoteError
} from "./canton-price-tradecraft";
import { assertCantonQuoteSanity } from "./canton-quote-sanity";
import { applyOutputFee } from "./htlc-quote-math";
import { BRIDGE_FEE_BPS, QUOTE_TTL_SECONDS } from "./htlc-quote";

export {
  CantonQuoteSanityError,
  CantonQuoteUnavailableError
} from "./canton-quote-errors";
import { CantonQuoteUnavailableError } from "./canton-quote-errors";

export interface CantonQuoteResult {
  fromAsset: CantonSwapAssetId;
  toAsset: CantonSwapAssetId;
  inUnits: bigint;
  grossOutUnits: bigint;
  outUnits: bigint;
  feeBps: number;
  expiresAt: number;
  source: "tradecraft";
  ageMs: number;
  stale: boolean;
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
  let freshness: { ageMs: number; stale: boolean };
  try {
    const quote = await tradecraftQuoteFixedInputWithMeta({
      from: fromAsset,
      to: toAsset,
      givingAmount: inDec
    });
    freshness = {
      ageMs: quote.ageMs,
      stale: quote.stale
    };
    gross = toBaseUnitsFloor(
      quote.userGets.toFixed(Math.min(18, to.decimals + 8)),
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

  // Tradecraft is executable liquidity, but it is not a trusted oracle. Refuse
  // quotes whose implied price is materially detached from independent CC/USD
  // and BTC/USD references so a bad pool cannot drain settlement float.
  await assertCantonQuoteSanity(fromAsset, toAsset, inUnits, gross);

  const outUnits = applyOutputFee(gross, BRIDGE_FEE_BPS);
  if (outUnits <= 0n) {
    throw new Error("quote output must be > 0 after fee");
  }

  return {
    fromAsset,
    toAsset,
    inUnits,
    grossOutUnits: gross,
    outUnits,
    feeBps: BRIDGE_FEE_BPS,
    expiresAt: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS,
    source: "tradecraft",
    ageMs: freshness.ageMs,
    stale: freshness.stale
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
