import { fromBaseUnits, toBaseUnitsFloor } from "../../../lib/amount-units";
import { DEFAULT_PLATFORM_FEE_BPS } from "../../../lib/constants";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import { applyOutputFee } from "../../../lib/htlc-quote-math";
import type { FarmAsset } from "./types";

const TRADECRAFT_BASE = process.env.TRADECRAFT_API_URL ?? "https://api.tradecraft.fi/v1";
const TRADECRAFT_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "OranjSwap-Farm/1.0 (+https://oranjswap.com)"
};

const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS);

function tradecraftSymbol(id: FarmAsset): string {
  return id;
}

export async function tradecraftQuoteFixedInput(params: {
  from: FarmAsset;
  to: FarmAsset;
  givingAmount: string;
}): Promise<number> {
  const a = encodeURIComponent(tradecraftSymbol(params.from));
  const b = encodeURIComponent(tradecraftSymbol(params.to));
  const url = `${TRADECRAFT_BASE}/quoteForFixedInput/${a}/${b}?givingAmount=${encodeURIComponent(params.givingAmount)}`;
  const r = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: TRADECRAFT_HEADERS
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Tradecraft quote failed (${r.status}): ${body.slice(0, 200)}`);
  }
  const j = (await r.json()) as { user_gets?: number; error?: string };
  if (j.error) throw new Error(j.error);
  if (typeof j.user_gets !== "number" || !Number.isFinite(j.user_gets) || j.user_gets <= 0) {
    throw new Error("Tradecraft returned invalid user_gets");
  }
  return j.user_gets;
}

export async function quoteFarmSwap(params: {
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
}): Promise<{ outAmount: string; feeBps: number }> {
  if (params.fromAsset === params.toAsset) {
    throw new Error("fromAsset and toAsset must differ");
  }
  const from = params.fromAsset === "CBTC" ? CBTC_ASSET : CC_ASSET;
  const to = params.toAsset === "CBTC" ? CBTC_ASSET : CC_ASSET;
  const inUnits = toBaseUnitsFloor(params.inAmount, from.decimals);
  if (inUnits <= 0n) throw new Error("inAmount must be > 0");

  const userGets = await tradecraftQuoteFixedInput({
    from: params.fromAsset,
    to: params.toAsset,
    givingAmount: params.inAmount
  });
  const gross = toBaseUnitsFloor(
    userGets.toFixed(Math.min(18, to.decimals + 8)),
    to.decimals
  );
  if (gross <= 0n) throw new Error("quote output must be > 0");
  const outUnits = applyOutputFee(gross, FEE_BPS);
  if (outUnits <= 0n) throw new Error("quote output must be > 0 after fee");
  return {
    outAmount: fromBaseUnits(outUnits, to.decimals),
    feeBps: FEE_BPS
  };
}
