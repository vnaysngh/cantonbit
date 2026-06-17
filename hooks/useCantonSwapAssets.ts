"use client";

import { useQuery } from "@tanstack/react-query";

import type { CantonSwapAssetId } from "@/lib/canton-assets";

export interface CantonSwapAssetMeta {
  id: CantonSwapAssetId;
  symbol: string;
  label: string;
  decimals: number;
}

const FALLBACK: CantonSwapAssetMeta[] = [
  { id: "CBTC", symbol: "CBTC", label: "BitSafe", decimals: 8 },
  { id: "CC", symbol: "CC", label: "Canton Coin", decimals: 10 }
];

export const CANTON_SWAP_ASSET_FALLBACK = FALLBACK;

/** Server-driven list (includes USDCX when CANTON_USDCX_ADMIN is set). */
export function useCantonSwapAssets() {
  return useQuery({
    queryKey: ["canton-swap-assets"],
    queryFn: async (): Promise<CantonSwapAssetMeta[]> => {
      const r = await fetch("/api/canton/swap/assets");
      if (!r.ok) return FALLBACK;
      const j = (await r.json()) as { assets?: CantonSwapAssetMeta[] };
      return j.assets?.length ? j.assets : FALLBACK;
    },
    staleTime: 60_000
  });
}
