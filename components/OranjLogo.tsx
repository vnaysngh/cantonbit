"use client";

import { cn } from "@/lib/utils";

/**
 * Oranj logomark — a broken ring with a currency-style vertical stem inside.
 *
 * The arc is an open circle with a gap at the bottom-right, and two thin
 * horizontal crossbars on the centred stem — abstractly financial, not a
 * literal Bitcoin symbol. Inherits `currentColor` so it works on both
 * light and dark backgrounds automatically.
 *
 * Pairs with the "Oranj" wordmark in TopNav. Scales cleanly from 16px up.
 */
export function OranjLogo({
  className,
  size = 28,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      width={size}
      height={size}
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      {/*
        Broken ring: strokeDasharray creates an arc that runs ~290° with a
        gap at the bottom-right. strokeLinecap="round" softens both ends.
        r=10 → circumference ≈ 62.8. We want ~53 px arc, 10 px gap.
      */}
      <circle
        cx="16"
        cy="16"
        r="10"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeDasharray="53 10"
        strokeDashoffset="-3"
      />
      {/* Vertical stem — centred inside the ring */}
      <line
        x1="16" y1="9.5"
        x2="16" y2="22.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* Upper crossbar */}
      <line
        x1="12.5" y1="13.5"
        x2="19.5" y2="13.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Lower crossbar */}
      <line
        x1="12.5" y1="18.5"
        x2="19.5" y2="18.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
