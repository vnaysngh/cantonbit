import type { InstrumentId } from "./constants";
import { NETWORK } from "./constants";

/** Assets supported for participant-managed P2P transfers. */
export type CantonTransferAssetId = "CBTC" | "CC";

/** Assets supported for same-Canton HTLC swaps. */
export type CantonSwapAssetId = "CBTC" | "CC" | "USDCX";

export type CantonRegistryKind = "cbtc" | "cc";

export interface CantonAsset {
  id: CantonSwapAssetId;
  symbol: string;
  label: string;
  /** Decimal places for amount input validation. */
  decimals: number;
  instrumentId: InstrumentId;
  /** Which off-ledger registry serves TransferFactory / allocation endpoints. */
  registryKind: CantonRegistryKind;
  /** CoinGecko simple/price id for USD quotes; null = hardcoded $1 (USDCX). */
  coingeckoId: string | null;
}

function resolveUsdcxAdmin(): string {
  return (
    process.env.CANTON_USDCX_ADMIN ??
    process.env.NEXT_PUBLIC_CANTON_USDCX_ADMIN ??
    ""
  );
}

export const CBTC_ASSET: CantonAsset = {
  id: "CBTC",
  symbol: "CBTC",
  label: "BitSafe",
  decimals: 8,
  instrumentId: NETWORK.instrumentId,
  registryKind: "cbtc",
  coingeckoId: "bitcoin"
};

/** CC instrument admin is the network DSO — resolved at transfer time. */
export const CC_ASSET: CantonAsset = {
  id: "CC",
  symbol: "CC",
  label: "Canton Coin",
  decimals: 10,
  instrumentId: { admin: "", id: "Amulet" },
  registryKind: "cc",
  coingeckoId: "canton-coin"
};

export function usdcxAsset(): CantonAsset | null {
  const admin = resolveUsdcxAdmin();
  if (!admin) return null;
  return {
    id: "USDCX",
    symbol: "USDCX",
    label: "USDCX",
    decimals: 6,
    instrumentId: { admin, id: "USDCX" },
    registryKind: "cbtc",
    coingeckoId: null
  };
}

/** All swap assets enabled for the current network (USDCX omitted when admin unset). */
export function enabledCantonSwapAssets(): CantonAsset[] {
  const out: CantonAsset[] = [CBTC_ASSET, CC_ASSET];
  const usdcx = usdcxAsset();
  if (usdcx) out.push(usdcx);
  return out;
}

export const CANTON_TRANSFER_ASSETS: CantonTransferAssetId[] = ["CBTC", "CC"];

export type CantonTransferAsset = Pick<
  CantonAsset,
  "id" | "symbol" | "label" | "decimals" | "instrumentId"
> & { id: CantonTransferAssetId };

export const CBTC_TRANSFER_ASSET: CantonTransferAsset = {
  id: "CBTC",
  symbol: CBTC_ASSET.symbol,
  label: CBTC_ASSET.label,
  decimals: CBTC_ASSET.decimals,
  instrumentId: CBTC_ASSET.instrumentId
};

export const CC_TRANSFER_ASSET: Omit<CantonTransferAsset, "instrumentId"> & {
  instrumentId: Omit<InstrumentId, "admin"> & { admin?: string };
} = {
  id: "CC",
  symbol: CC_ASSET.symbol,
  label: CC_ASSET.label,
  decimals: CC_ASSET.decimals,
  instrumentId: CC_ASSET.instrumentId
};

export function getSwapAsset(id: CantonSwapAssetId): CantonAsset {
  if (id === "CBTC") return CBTC_ASSET;
  if (id === "CC") return CC_ASSET;
  const usdcx = usdcxAsset();
  if (!usdcx) {
    throw new Error(
      "USDCX is not configured — set CANTON_USDCX_ADMIN in the environment"
    );
  }
  return usdcx;
}

export function getTransferAsset(id: CantonTransferAssetId): CantonTransferAsset {
  if (id === "CBTC") return CBTC_TRANSFER_ASSET;
  return {
    ...CC_TRANSFER_ASSET,
    instrumentId: { admin: "", id: "Amulet" }
  };
}

export function parseTransferAssetId(raw: unknown): CantonTransferAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  return null;
}

export function parseSwapAssetId(raw: unknown): CantonSwapAssetId | null {
  if (raw === "CBTC" || raw === "CC") return raw;
  if (raw === "USDCX" && usdcxAsset()) return "USDCX";
  return null;
}

/** Enabled same-Canton swap pairs (both directions). */
export function enabledCantonPairs(): Array<[CantonSwapAssetId, CantonSwapAssetId]> {
  const ids = enabledCantonSwapAssets().map((a) => a.id);
  const pairs: Array<[CantonSwapAssetId, CantonSwapAssetId]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  return pairs;
}

export function isCantonPair(
  from: CantonSwapAssetId,
  to: CantonSwapAssetId
): boolean {
  if (from === to) return false;
  return enabledCantonPairs().some(
    ([a, b]) =>
      (a === from && b === to) || (a === to && b === from)
  );
}

/** Match a ledger holding instrument to a target (Amulet matches on id only). */
export function matchesInstrument(
  holdingInst: { admin?: string; id?: string } | undefined,
  target: InstrumentId
): boolean {
  if (!holdingInst?.id || holdingInst.id !== target.id) return false;
  if (target.id === "Amulet") return true;
  return holdingInst.admin === target.admin;
}

/** Resolve instrumentId for registry/API calls (CC admin filled at runtime when needed). */
export function resolvedInstrumentId(asset: CantonAsset): InstrumentId {
  if (asset.id !== "CC") return asset.instrumentId;
  return { admin: asset.instrumentId.admin || "", id: "Amulet" };
}
