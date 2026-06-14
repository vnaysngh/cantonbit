import Image from "next/image";

import type { CantonSwapAssetId } from "@/lib/canton-assets";
import { cn } from "@/lib/utils";

export type SwapTokenId = CantonSwapAssetId | "WBTC";

const TOKEN_META: Record<
  SwapTokenId,
  { src: string; alt: string; label: string }
> = {
  CBTC: { src: "/cbtc.png", alt: "BitSafe CBTC", label: "BitSafe" },
  CC: { src: "/cc-logo.png", alt: "Canton Coin", label: "Canton Coin" },
  USDCX: { src: "/usdcx.png", alt: "USDCX", label: "USDCX" },
  WBTC: { src: "/wbtc.png", alt: "Wrapped BTC", label: "Wrapped Bitcoin" }
};

/** Token logo for swap UI (Canton assets + WBTC). */
export function TokenIcon({
  token,
  className,
  size = "md"
}: {
  token: SwapTokenId;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const meta = TOKEN_META[token];
  const dim =
    size === "sm" ? "size-6" : size === "lg" ? "size-10" : "size-8";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/10",
        dim,
        className
      )}
    >
      <Image
        src={meta.src}
        alt={meta.alt}
        fill
        sizes={size === "lg" ? "40px" : size === "sm" ? "24px" : "32px"}
        className="rounded-full object-cover"
      />
    </span>
  );
}

export function tokenLabel(token: SwapTokenId): string {
  return TOKEN_META[token].label;
}

export function tokenSymbol(token: SwapTokenId): string {
  return token;
}
