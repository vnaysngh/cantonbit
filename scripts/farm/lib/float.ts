import { toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import type { FarmAsset, FarmFleetConfig } from "./types";
import { cbtcBalance, ccBalance, countHoldings, holdingsForAsset } from "./ledger";
import {
  isVaultCbtcCacheParty,
  vaultCbtcCacheSpendable,
  vaultCbtcCachedBalance
} from "./vault-cbtc-holdings";

const UTXO_WARN = 8;
const UTXO_MAX = 10;

export interface FloatCheckResult {
  ok: boolean;
  reason?: string;
}

export async function checkTraderFloat(params: {
  jwt: string;
  traderParty: string;
  fromAsset: FarmAsset;
  inAmount: string;
}): Promise<FloatCheckResult> {
  const asset = params.fromAsset === "CBTC" ? CBTC_ASSET : CC_ASSET;
  const holdings = await holdingsForAsset(
    params.jwt,
    params.traderParty,
    params.fromAsset
  );
  const utxoCount = holdings.length;

  if (utxoCount >= UTXO_MAX) {
    return { ok: false, reason: `trader UTXO at cap (${utxoCount}/${UTXO_MAX})` };
  }
  if (utxoCount >= UTXO_WARN) {
    console.warn(`⚠ trader UTXO high: ${utxoCount}/${UTXO_MAX}`);
  }

  let total = 0n;
  for (const h of holdings) {
    total += toBaseUnitsFloor(h.payload?.amount ?? "0", asset.decimals);
  }
  const need = toBaseUnitsFloor(params.inAmount, asset.decimals);
  if (total < need) {
    return {
      ok: false,
      reason: `trader insufficient ${params.fromAsset}: have ${total}, need ${need}`
    };
  }
  return { ok: true };
}

export async function checkVaultFloat(params: {
  jwt: string;
  vaultParty: string;
  toAsset: FarmAsset;
  outAmount: string;
}): Promise<FloatCheckResult> {
  const asset = params.toAsset === "CBTC" ? CBTC_ASSET : CC_ASSET;
  let total = 0n;
  if (
    params.toAsset === "CBTC" &&
    isVaultCbtcCacheParty(params.vaultParty) &&
    vaultCbtcCacheSpendable()
  ) {
    total = toBaseUnitsFloor(vaultCbtcCachedBalance(), asset.decimals);
  } else {
    const holdings = await holdingsForAsset(
      params.jwt,
      params.vaultParty,
      params.toAsset
    );
    for (const h of holdings) {
      total += toBaseUnitsFloor(h.payload?.amount ?? "0", asset.decimals);
    }
  }
  const need = toBaseUnitsFloor(params.outAmount, asset.decimals);
  if (total < need) {
    return {
      ok: false,
      reason: `vault insufficient ${params.toAsset} float`
    };
  }
  return { ok: true };
}

export async function checkSwapFloat(params: {
  jwt: string;
  fleet: FarmFleetConfig;
  traderParty: string;
  fromAsset: FarmAsset;
  toAsset: FarmAsset;
  inAmount: string;
  outAmount: string;
}): Promise<FloatCheckResult> {
  const trader = await checkTraderFloat({
    jwt: params.jwt,
    traderParty: params.traderParty,
    fromAsset: params.fromAsset,
    inAmount: params.inAmount
  });
  if (!trader.ok) return trader;
  return checkVaultFloat({
    jwt: params.jwt,
    vaultParty: params.fleet.vault,
    toAsset: params.toAsset,
    outAmount: params.outAmount
  });
}

export async function partyBalancesSummary(
  jwt: string,
  party: string,
  opts?: { countUtxo?: boolean }
) {
  const countUtxo = opts?.countUtxo !== false;
  const [cbtc, cc, counts] = await Promise.all([
    cbtcBalance(jwt, party),
    ccBalance(jwt, party),
    countUtxo
      ? countHoldings(jwt, party)
      : Promise.resolve({ cbtc: 0, cc: 0 })
  ]);
  return { cbtc, cc, utxoCbtc: counts.cbtc, utxoCc: counts.cc };
}
