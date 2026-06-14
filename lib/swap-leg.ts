import type { CantonSwapAssetId } from "@/lib/canton-assets";
import { SWAP_CHAIN } from "@/lib/swap-evm";

export type SwapChain = "canton" | "evm";

export type SwapLeg =
  | { chain: "evm"; token: "WBTC" }
  | { chain: "canton"; token: CantonSwapAssetId };

export type SwapKind =
  | "evm-to-canton"
  | "canton-to-evm"
  | "canton-to-canton"
  | "invalid-evm-evm"
  | "invalid-same-asset";

export function resolveSwapKind(pay: SwapLeg, receive: SwapLeg): SwapKind {
  if (pay.chain === "evm" && receive.chain === "evm") return "invalid-evm-evm";
  if (pay.chain === "canton" && receive.chain === "canton") {
    if (pay.token === receive.token) return "invalid-same-asset";
    return "canton-to-canton";
  }
  if (pay.chain === "evm" && receive.chain === "canton") return "evm-to-canton";
  if (pay.chain === "canton" && receive.chain === "evm") return "canton-to-evm";
  return "invalid-evm-evm";
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
  enabledCanton: CantonSwapAssetId[] = ["CBTC", "CC", "USDCX"]
): { pay: SwapLeg; receive: SwapLeg } {
  let p = pay;
  let r = receive;

  if (p.chain === "evm" && r.chain === "evm") {
    r = { chain: "canton", token: "CBTC" };
  }

  if (
    p.chain === "canton" &&
    r.chain === "canton" &&
    p.token === r.token
  ) {
    r = { chain: "canton", token: alternateCantonToken(p.token, enabledCanton) };
  }

  return { pay: p, receive: r };
}

export function applyLegChange(
  side: "pay" | "receive",
  next: SwapLeg,
  pay: SwapLeg,
  receive: SwapLeg,
  enabledCanton: CantonSwapAssetId[] = ["CBTC", "CC", "USDCX"]
): { pay: SwapLeg; receive: SwapLeg } {
  const draftPay = side === "pay" ? next : pay;
  const draftReceive = side === "receive" ? next : receive;
  return normalizeSwapLegs(draftPay, draftReceive, enabledCanton);
}

export function legDisplay(leg: SwapLeg): { token: string; network: string } {
  if (leg.chain === "evm") {
    return { token: "WBTC", network: SWAP_CHAIN.name };
  }
  return { token: leg.token, network: "Canton" };
}
