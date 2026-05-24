"use client";

import { formatBtc } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  amount: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  unit?: string;
}

const sizeClass: Record<NonNullable<Props["size"]>, string> = {
  sm: "text-base",
  md: "text-2xl",
  lg: "text-4xl",
  xl: "text-6xl",
};

export function BalanceBadge({
  amount,
  size = "md",
  className,
  unit = "cBTC",
}: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-2 font-mono tabular-nums",
        sizeClass[size],
        className,
      )}
    >
      <span>{formatBtc(amount)}</span>
      <span className="text-muted-foreground text-sm">{unit}</span>
    </span>
  );
}
