import type { CantonSwapAssetId } from "@/lib/canton-assets";
import { SWAP_CHAIN } from "@/lib/swap-evm";

export type SwapChain = "canton" | "evm";

export type SwapLeg =
  | { chain: "evm"; token: "WBTC" }
  | { chain: "canton"; token: CantonSwapAssetId };

/** Cross-chain HTLC leg on Canton — not CC / USDCX. */
export const CROSS_CHAIN_CANTON_ASSET =
  "CBTC" as const satisfies CantonSwapAssetId;

export type SwapKind =
  | "evm-to-canton"
  | "canton-to-evm"
  | "canton-to-canton"
  | "invalid-evm-evm"
  | "invalid-same-asset"
  | "invalid-cross-chain-canton";

export function resolveSwapKind(pay: SwapLeg, receive: SwapLeg): SwapKind {
  if (pay.chain === "evm" && receive.chain === "evm") return "invalid-evm-evm";
  if (pay.chain === "canton" && receive.chain === "canton") {
    if (pay.token === receive.token) return "invalid-same-asset";
    return "canton-to-canton";
  }
  if (pay.chain === "evm" && receive.chain === "canton") {
    if (receive.token !== CROSS_CHAIN_CANTON_ASSET) {
      return "invalid-cross-chain-canton";
    }
    return "evm-to-canton";
  }
  if (pay.chain === "canton" && receive.chain === "evm") {
    if (pay.token !== CROSS_CHAIN_CANTON_ASSET) {
      return "invalid-cross-chain-canton";
    }
    return "canton-to-evm";
  }
  return "invalid-evm-evm";
}

/** True when the opposite leg forces this picker to Canton CBTC only (WBTC cross-chain). */
export function crossChainCantonPickerOnly(
  leg: SwapLeg,
  otherLeg?: SwapLeg
): boolean {
  return otherLeg?.chain === "evm" || leg.chain === "evm";
}

/** WBTC is only valid when the other leg is Canton CBTC (cross-chain). */
export function wbtcPickerBlocked(otherLeg?: SwapLeg): boolean {
  if (otherLeg?.chain === "evm") return true;
  if (
    otherLeg?.chain === "canton" &&
    otherLeg.token !== CROSS_CHAIN_CANTON_ASSET
  ) {
    return true;
  }
  return false;
}

export type SwapFeatureFlags = {
  crossChainEnabled?: boolean;
  c2cEnabled?: boolean;
};

/** Whether a token row is disabled in the picker. */
export function swapLegPickerDisabled(
  candidate: SwapLeg,
  otherLeg?: SwapLeg,
  flags?: SwapFeatureFlags
): boolean {
  const crossChainEnabled = flags?.crossChainEnabled ?? true;
  const c2cEnabled = flags?.c2cEnabled ?? true;
  if (candidate.chain === "evm") {
    if (!crossChainEnabled) return true;
    if (otherLeg?.chain === "evm") return true;
    if (
      otherLeg?.chain === "canton" &&
      otherLeg.token !== CROSS_CHAIN_CANTON_ASSET
    ) {
      return true;
    }
    return false;
  }

  if (
    otherLeg?.chain === "canton" &&
    candidate.chain === "canton" &&
    !c2cEnabled
  ) {
    return true;
  }

  if (otherLeg?.chain === "canton" && otherLeg.token === candidate.token) {
    return true;
  }
  if (
    otherLeg?.chain === "evm" &&
    candidate.token !== CROSS_CHAIN_CANTON_ASSET
  ) {
    return true;
  }
  return false;
}

export function crossChainPickerHint(
  otherLeg?: SwapLeg,
  leg?: SwapLeg
): string | null {
  if (otherLeg?.chain === "evm" || leg?.chain === "evm") {
    return "Cross-chain swaps are WBTC ↔ CBTC only.";
  }
  return null;
}

/** Pick a different Canton token for the opposite leg. */
export function alternateCantonToken(
  current: CantonSwapAssetId,
  enabled: CantonSwapAssetId[]
): CantonSwapAssetId {
  const next = enabled.find((t) => t !== current);
  return next ?? "CBTC";
}

/**
 * Enforce swap leg rules:
 * - EVM (WBTC) only on one side — cross-chain only.
 * - Same Canton token cannot be on both sides.
 */
export function normalizeSwapLegs(
  pay: SwapLeg,
  receive: SwapLeg,
  enabledCanton: CantonSwapAssetId[] = ["CBTC", "CC", "USDCX"],
  flags?: SwapFeatureFlags
): { pay: SwapLeg; receive: SwapLeg } {
  const crossChainEnabled = flags?.crossChainEnabled ?? true;
  const c2cEnabled = flags?.c2cEnabled ?? true;
  let p = pay;
  let r = receive;

  if (!crossChainEnabled && !c2cEnabled) {
    return { pay: p, receive: r };
  }

  if (!crossChainEnabled && (p.chain === "evm" || r.chain === "evm")) {
    p = { chain: "canton", token: CROSS_CHAIN_CANTON_ASSET };
    r = {
      chain: "canton",
      token: alternateCantonToken(CROSS_CHAIN_CANTON_ASSET, enabledCanton)
    };
  }

  if (!c2cEnabled && p.chain === "canton" && r.chain === "canton") {
    if (crossChainEnabled) {
      p = { chain: "evm", token: "WBTC" };
      r = { chain: "canton", token: CROSS_CHAIN_CANTON_ASSET };
    }
  }

  if (p.chain === "evm" && r.chain === "evm") {
    r = { chain: "canton", token: CROSS_CHAIN_CANTON_ASSET };
  }

  const crossChain = p.chain === "evm" || r.chain === "evm";
  if (crossChain) {
    if (p.chain === "canton" && p.token !== CROSS_CHAIN_CANTON_ASSET) {
      p = { chain: "canton", token: CROSS_CHAIN_CANTON_ASSET };
    }
    if (r.chain === "canton" && r.token !== CROSS_CHAIN_CANTON_ASSET) {
      r = { chain: "canton", token: CROSS_CHAIN_CANTON_ASSET };
    }
  }

  if (p.chain === "canton" && r.chain === "canton" && p.token === r.token) {
    r = {
      chain: "canton",
      token: alternateCantonToken(p.token, enabledCanton)
    };
  }

  return { pay: p, receive: r };
}

export function applyLegChange(
  side: "pay" | "receive",
  next: SwapLeg,
  pay: SwapLeg,
  receive: SwapLeg,
  enabledCanton: CantonSwapAssetId[] = ["CBTC", "CC", "USDCX"],
  flags?: SwapFeatureFlags
): { pay: SwapLeg; receive: SwapLeg } {
  const draftPay = side === "pay" ? next : pay;
  const draftReceive = side === "receive" ? next : receive;
  return normalizeSwapLegs(draftPay, draftReceive, enabledCanton, flags);
}

export function legDisplay(leg: SwapLeg): { token: string; network: string } {
  if (leg.chain === "evm") {
    return { token: "WBTC", network: SWAP_CHAIN.name };
  }
  return { token: leg.token, network: "Canton" };
}
