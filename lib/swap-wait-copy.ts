import { DELAYED_AFTER_SECONDS } from "./swap-api";

/** Same threshold as Orders progress ("Taking longer than usual"). */
export const SWAP_WAIT_EXTENDED_AFTER_SECONDS = DELAYED_AFTER_SECONDS;

export const SWAP_WAIT_POLL_MS = 4_000;

export type SwapWaitMode = "solver" | "locking" | "settling";

export function swapWaitPrimaryLabel(params: {
  elapsedSec: number;
  mode: SwapWaitMode;
  /** Reverse HTLC: solver locks WBTC, not CBTC counter. */
  reverse?: boolean;
  /** Forward managed (email wallet): solver locks CBTC on Canton, not C2C fill. */
  forwardManaged?: boolean;
}): string {
  const { elapsedSec, mode, reverse, forwardManaged } = params;
  const extended = elapsedSec >= SWAP_WAIT_EXTENDED_AFTER_SECONDS;
  if (mode === "locking") {
    return extended ? "Still signing in Loop…" : "Sign in Loop wallet…";
  }
  if (mode === "settling") {
    return extended ? "Still finishing your swap…" : "Finishing your swap…";
  }
  if (reverse) {
    return extended ? "Still locking WBTC…" : "Locking WBTC on chain…";
  }
  if (forwardManaged) {
    return extended
      ? "Still locking CBTC on Canton…"
      : "Locking CBTC on Canton…";
  }
  return extended ? "Still finding a solver…" : "Waiting for solver…";
}

export function swapWaitHint(elapsedSec: number): string | null {
  if (elapsedSec < SWAP_WAIT_EXTENDED_AFTER_SECONDS) return null;
  return "This is taking longer than usual. Your funds are safe — track progress on the Orders page.";
}

export function swapWaitTerminalMessage(status: string): string {
  switch (status) {
    case "refunded":
      return "This swap was refunded and your funds were returned.";
    case "cancelled":
      return "This swap was cancelled.";
    case "failed":
      return "This swap could not be completed. Check Orders for details.";
    default:
      return "This swap is no longer in progress. Check Orders for the latest status.";
  }
}
