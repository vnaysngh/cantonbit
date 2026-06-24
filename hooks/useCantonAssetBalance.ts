"use client";

import { useQuery } from "@tanstack/react-query";

import type { CantonSwapAssetId } from "@/lib/canton-assets";
import { readLoopInstrumentBalance } from "@/lib/loop-holdings";
import { useLoopWallet } from "./useLoopWallet";
import { balanceQueryKey } from "@/lib/balance-query";

/** Per-asset Canton balance for swap UI (Loop + email paths). */
export function useCantonAssetBalance(assetId: CantonSwapAssetId) {
  const { provider, connected, party } = useLoopWallet();
  const useLoop = connected && !!provider;

  return useQuery({
    queryKey: [...balanceQueryKey(useLoop ? party : "session"), "asset", assetId],
    queryFn: async (): Promise<string> => {
      if (useLoop && provider) {
        const { NETWORK } = await import("@/lib/constants");
        const { getSwapAsset } = await import("@/lib/canton-assets");
        const asset = getSwapAsset(assetId);
        let instrumentId = asset.instrumentId;
        if (assetId === "CC") {
          const { readLoopCcBalance } = await import("@/lib/loop-holdings");
          return readLoopCcBalance(provider);
        }
        if (assetId === "CBTC") {
          instrumentId = NETWORK.instrumentId;
        }
        const { total } = await readLoopInstrumentBalance(provider, instrumentId);
        return total;
      }
      const r = await fetch(
        `/api/parties/asset-balance?asset=${encodeURIComponent(assetId)}`
      );
      if (!r.ok) return "0";
      const j = (await r.json()) as { total?: string };
      return j.total ?? "0";
    },
    refetchInterval: 30_000
  });
}
