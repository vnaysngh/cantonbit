import { toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import type { FarmAsset, FarmFleetConfig } from "./types";
import { cbtcBalance, ccBalance, countHoldings, holdingsForAsset } from "./ledger";

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
  const holdings = await holdingsForAsset(params.jwt, params.traderParty, params.fromAsset);
  const utxoCount =
    params.fromAsset === "CBTC"
      ? holdings.length
      : (await countHoldings(params.jwt, params.traderParty)).cc;

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
  const holdings = await holdingsForAsset(params.jwt, params.vaultParty, params.toAsset);
  let total = 0n;
  for (const h of holdings) {
    total += toBaseUnitsFloor(h.payload?.amount ?? "0", asset.decimals);
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

export async function partyBalancesSummary(jwt: string, party: string) {
  const [cbtc, cc, counts] = await Promise.all([
    cbtcBalance(party),
    ccBalance(jwt, party),
    countHoldings(jwt, party)
  ]);
  return { cbtc, cc, utxoCbtc: counts.cbtc, utxoCc: counts.cc };
}
