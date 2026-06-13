import type { InstrumentId } from "./constants";
import { NETWORK } from "./constants";

/** Assets supported for participant-managed P2P transfers. */
export type CantonTransferAssetId = "CBTC" | "CC";

export interface CantonTransferAsset {
  id: CantonTransferAssetId;
  symbol: string;
  label: string;
  /** Decimal places for amount input validation. */
  decimals: number;
  instrumentId: InstrumentId;
}

export const CBTC_TRANSFER_ASSET: CantonTransferAsset = {
  id: "CBTC",
  symbol: "CBTC",
  label: "BitSafe",
  decimals: 8,
  instrumentId: NETWORK.instrumentId
};

/** CC instrument admin is the network DSO — resolved at transfer time. */
export const CC_TRANSFER_ASSET: Omit<CantonTransferAsset, "instrumentId"> & {
  instrumentId: Omit<InstrumentId, "admin"> & { admin?: string };
} = {
  id: "CC",
  symbol: "CC",
  label: "Canton Coin",
  decimals: 10,
  instrumentId: { id: "Amulet" }
};

export const CANTON_TRANSFER_ASSETS: CantonTransferAssetId[] = ["CBTC", "CC"];

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
