import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Primary-tint callout for Loop wallet pop-up / pending-signature guidance. */
export function LoopWalletHint({
  children,
  className,
  icon = "info",
  variant = "info",
  actionLabel,
  onAction
}: {
  children: ReactNode;
  className?: string;
  icon?: "info" | "open_in_new" | "account_balance_wallet" | "block";
  variant?: "info" | "blocked";
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-6 text-foreground",
        variant === "blocked"
          ? "border-primary/50 bg-primary/15 shadow-[inset_0_1px_0_0_rgba(155,68,40,0.12)] ring-1 ring-primary/25"
          : "border-primary/30 bg-primary/10 shadow-[inset_0_1px_0_0_rgba(155,68,40,0.08)]",
        className
      )}
    >
      <span
        className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-primary"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground/95">{children}</p>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-2 hover:underline"
          >
            {actionLabel}
            <span className="material-symbols-outlined text-[16px]" aria-hidden>
              open_in_new
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
