import { getInstrumentHoldings } from "./canton";
import {
  getSwapAsset,
  resolvedInstrumentId,
  type CantonSwapAssetId
} from "./canton-assets";
import { getDsoPartyId } from "./cc-registry";
import type { InstrumentId } from "./constants";
import type { CantonSwapMvpAssetId } from "./canton-swap-types";

export async function resolveSwapInstrumentId(
  assetId: CantonSwapAssetId
): Promise<InstrumentId> {
  const asset = getSwapAsset(assetId);
  if (asset.id !== "CC") return resolvedInstrumentId(asset);
  return { admin: await getDsoPartyId(), id: "Amulet" };
}

export async function holdingsForSwapAsset(
  party: string,
  assetId: CantonSwapAssetId
) {
  const instrumentId = await resolveSwapInstrumentId(assetId);
  return getInstrumentHoldings(party, instrumentId);
}

export function registryKindForAsset(assetId: CantonSwapMvpAssetId): "cbtc" | "cc" {
  return getSwapAsset(assetId).registryKind;
}

export async function registrarAdminForAsset(
  assetId: CantonSwapMvpAssetId
): Promise<string> {
  const instrumentId = await resolveSwapInstrumentId(assetId);
  return instrumentId.admin;
}
