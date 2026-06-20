import Link from "next/link";

import {
  swapWaitHint,
  swapWaitPrimaryLabel,
  type SwapWaitMode
} from "@/lib/swap-wait-copy";

type SwapWaitBannerProps = {
  elapsedSec: number;
  mode: SwapWaitMode;
  orderId: string;
  ordersHref: string;
  onStartNewSwap?: () => void;
  reverse?: boolean;
  forwardManaged?: boolean;
};

export function swapWaitButtonLabel(
  elapsedSec: number,
  mode: SwapWaitMode,
  reverse?: boolean,
  forwardManaged?: boolean
): string {
  return swapWaitPrimaryLabel({ elapsedSec, mode, reverse, forwardManaged });
}

export function SwapWaitBanner({
  elapsedSec,
  mode,
  orderId,
  ordersHref,
  onStartNewSwap,
  reverse,
  forwardManaged
}: SwapWaitBannerProps) {
  const hint = swapWaitHint(elapsedSec);
  return (
    <div className="mt-3 space-y-3 text-left">
      {hint && (
        <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm leading-6 text-foreground">
          {hint}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link
          href={ordersHref}
          className="flex-1 rounded-2xl border border-foreground/15 px-4 py-2.5 text-center text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5"
        >
          View in Orders
        </Link>
        {onStartNewSwap && (
          <button
            type="button"
            onClick={onStartNewSwap}
            className="flex-1 rounded-2xl border border-foreground/10 px-4 py-2.5 text-center text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            Start a new swap
          </button>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Order {orderId.slice(0, 10)}…{orderId.slice(-6)}
      </p>
    </div>
  );
}
