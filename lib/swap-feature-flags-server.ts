import "server-only";

import { NextResponse } from "next/server";

import {
  assertC2cIntakeEnabled,
  assertCrossChainIntakeEnabled,
  C2cSwapDisabledError,
  c2cSwapDisabledMessage,
  CrossChainSwapDisabledError,
  crossChainSwapDisabledMessage,
  isC2cSwapEnabled,
  isCrossChainSwapEnabled,
  isHtlcEvmChainFamilyEnabled
} from "@/lib/swap-feature-flags";
import type { HtlcEvmChainSlug } from "@/lib/swap-evm";

export function crossChainDisabledResponse(
  slug?: string | null
): NextResponse | null {
  try {
    assertCrossChainIntakeEnabled(slug);
    return null;
  } catch (e) {
    if (!(e instanceof CrossChainSwapDisabledError)) throw e;
    return NextResponse.json(
      { error: crossChainSwapDisabledMessage(e.slug) },
      { status: 503 }
    );
  }
}

export function c2cDisabledResponse(): NextResponse | null {
  if (isC2cSwapEnabled()) return null;
  return NextResponse.json(
    { error: c2cSwapDisabledMessage() },
    { status: 503 }
  );
}

export function assertCrossChainIntakeEnabledOrThrow(slug?: string | null): void {
  assertCrossChainIntakeEnabled(slug);
}

export function assertC2cIntakeEnabledOrThrow(): void {
  assertC2cIntakeEnabled();
}

export function filterHtlcChainsForIntake<T extends { slug: HtlcEvmChainSlug }>(
  chains: T[]
): T[] {
  if (!isCrossChainSwapEnabled()) return [];
  return chains.filter((chain) => isHtlcEvmChainFamilyEnabled(chain.slug));
}
