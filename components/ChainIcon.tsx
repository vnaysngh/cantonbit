import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * The brand mark for a chain — Arbitrum (EVM source leg) or Canton
 * (destination). Uses the logos in /public, clipped to a circle (the Arbitrum
 * mark is a JPG with square white corners). Falls back to the Bitcoin ₿ glyph
 * for anything unrecognized.
 *
 * Shared between the swap card/review modal and the header wallet dropdown so
 * the chain identity is consistent everywhere it's shown.
 */
export function ChainIcon({
  network,
  className
}: {
  network: string;
  className?: string;
}) {
  const key = network.toLowerCase();
  const logo = key.includes("arbitrum")
    ? { src: "/base-logo.jpg", alt: "Arbitrum" }
    : key.includes("canton")
      ? { src: "/cc-logo.png", alt: "Canton" }
      : null;

  if (logo) {
    return (
      <span
        className={cn(
          "relative inline-flex size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/10",
          className
        )}
      >
        <Image
          src={logo.src}
          alt={logo.alt}
          fill
          sizes="32px"
          className="rounded-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-[#f7931a] text-sm font-bold text-white",
        className
      )}
    >
      ₿
    </span>
  );
}
