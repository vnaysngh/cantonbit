"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode
} from "react";

import type { SwapFeatureFlags } from "@/lib/swap-leg";
import {
  isHtlcEvmChainFamilyEnabledFromSnapshot,
  readSwapFeatureFlagsSnapshot,
  type SwapFeatureFlagsSnapshot
} from "@/lib/swap-feature-flags";
import {
  configuredHtlcEvmChains,
  type SwapChain
} from "@/lib/swap-evm";

const SwapFeatureFlagsContext = createContext<SwapFeatureFlagsSnapshot | null>(
  null
);

export function SwapFeatureFlagsProvider({
  flags,
  children
}: {
  flags: SwapFeatureFlagsSnapshot;
  children: ReactNode;
}) {
  return (
    <SwapFeatureFlagsContext.Provider value={flags}>
      {children}
    </SwapFeatureFlagsContext.Provider>
  );
}

/** Server-resolved flags from layout; falls back to NEXT_PUBLIC_* only if missing. */
export function useSwapFeatureFlags(): SwapFeatureFlagsSnapshot {
  const ctx = useContext(SwapFeatureFlagsContext);
  return ctx ?? readSwapFeatureFlagsSnapshot();
}

export function useEnabledHtlcEvmChains(): SwapChain[] {
  const flags = useSwapFeatureFlags();
  return useMemo(
    () =>
      configuredHtlcEvmChains().filter((chain) =>
        isHtlcEvmChainFamilyEnabledFromSnapshot(chain.slug, flags)
      ),
    [flags]
  );
}

export function useSwapLegFeatureFlags(): SwapFeatureFlags {
  const flags = useSwapFeatureFlags();
  return useMemo(
    () => ({
      crossChainEnabled: flags.crossChainEnabled,
      c2cEnabled: flags.c2cEnabled
    }),
    [flags.crossChainEnabled, flags.c2cEnabled]
  );
}
