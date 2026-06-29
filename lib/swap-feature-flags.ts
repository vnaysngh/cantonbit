import type { HtlcEvmChainSlug } from "@/lib/swap-evm";
import { readEnvFlag } from "@/lib/env-flag-enabled";

export type SwapFeatureFlagsSnapshot = {
  crossChainEnabled: boolean;
  htlcBaseEnabled: boolean;
  htlcArbitrumEnabled: boolean;
  c2cEnabled: boolean;
};

export function readSwapFeatureFlagsSnapshot(): SwapFeatureFlagsSnapshot {
  return {
    crossChainEnabled: isCrossChainSwapEnabled(),
    htlcBaseEnabled: isHtlcBaseFamilyEnabled(),
    htlcArbitrumEnabled: isHtlcArbitrumFamilyEnabled(),
    c2cEnabled: isC2cSwapEnabled()
  };
}

export function isHtlcEvmChainFamilyEnabledFromSnapshot(
  slug: HtlcEvmChainSlug,
  flags: SwapFeatureFlagsSnapshot
): boolean {
  if (!flags.crossChainEnabled) return false;
  if (slug === "base" || slug === "base-sepolia") {
    return flags.htlcBaseEnabled;
  }
  if (slug === "arbitrum" || slug === "arbitrum-sepolia") {
    return flags.htlcArbitrumEnabled;
  }
  return false;
}

export function isCrossChainSwapEnabled(): boolean {
  return readEnvFlag(
    "CROSS_CHAIN_SWAP_ENABLED",
    "NEXT_PUBLIC_CROSS_CHAIN_SWAP_ENABLED"
  );
}

export function isHtlcBaseFamilyEnabled(): boolean {
  return readEnvFlag("HTLC_BASE_ENABLED", "NEXT_PUBLIC_HTLC_BASE_ENABLED");
}

export function isHtlcArbitrumFamilyEnabled(): boolean {
  return readEnvFlag(
    "HTLC_ARBITRUM_ENABLED",
    "NEXT_PUBLIC_HTLC_ARBITRUM_ENABLED"
  );
}

export function isC2cSwapEnabled(): boolean {
  return readEnvFlag("C2C_SWAP_ENABLED", "NEXT_PUBLIC_C2C_SWAP_ENABLED");
}

export function isHtlcEvmChainFamilyEnabled(slug: HtlcEvmChainSlug): boolean {
  return isHtlcEvmChainFamilyEnabledFromSnapshot(
    slug,
    readSwapFeatureFlagsSnapshot()
  );
}

export function crossChainSwapDisabledMessage(slug?: string | null): string {
  if (slug === "base" || slug === "base-sepolia") {
    return "Base cross-chain swaps are temporarily unavailable.";
  }
  if (slug === "arbitrum" || slug === "arbitrum-sepolia") {
    return "Arbitrum cross-chain swaps are temporarily unavailable.";
  }
  return "Cross-chain swaps are temporarily unavailable.";
}

export function c2cSwapDisabledMessage(): string {
  return "Canton C2C swaps are temporarily unavailable.";
}

export class CrossChainSwapDisabledError extends Error {
  readonly slug?: string | null;

  constructor(slug?: string | null) {
    super(crossChainSwapDisabledMessage(slug));
    this.name = "CrossChainSwapDisabledError";
    this.slug = slug;
  }
}

export class C2cSwapDisabledError extends Error {
  constructor() {
    super(c2cSwapDisabledMessage());
    this.name = "C2cSwapDisabledError";
  }
}

export function assertCrossChainIntakeEnabled(slug?: string | null): void {
  if (!isCrossChainSwapEnabled()) {
    throw new CrossChainSwapDisabledError(slug);
  }
  const normalized = slug?.trim().toLowerCase();
  if (
    normalized === "base" ||
    normalized === "base-sepolia" ||
    normalized === "arbitrum" ||
    normalized === "arbitrum-sepolia"
  ) {
    if (!isHtlcEvmChainFamilyEnabled(normalized as HtlcEvmChainSlug)) {
      throw new CrossChainSwapDisabledError(normalized);
    }
  }
}

export function assertC2cIntakeEnabled(): void {
  if (!isC2cSwapEnabled()) {
    throw new C2cSwapDisabledError();
  }
}
