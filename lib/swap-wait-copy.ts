/** Only show "taking longer" copy after two minutes on the live swap status UI. */
export const SWAP_WAIT_EXTENDED_AFTER_SECONDS = 120;

export const SWAP_WAIT_POLL_MS = 4_000;

export type SwapWaitMode = "solver" | "locking" | "settling" | "finalize";

/** Shown before opening Loop for a transfer/signing prompt. */
export const LOOP_WALLET_POPUP_HINT =
  "Loop may open in a new tab — allow pop-ups for this site in your browser if you do not see it.";

/** Shown after a Loop transaction has been requested. */
export const LOOP_WALLET_PENDING_HINT =
  "Check your Loop wallet for the pending transaction. If Loop is already open, the signature may already be waiting there.";

export function swapFinalizeHint(params: { elapsedSec: number }): string {
  const { elapsedSec } = params;
  if (elapsedSec < 30) {
    return "Your part is done. Finishing the swap — usually under a minute.";
  }
  if (elapsedSec < 120) {
    return "Still finishing your swap. No wallet action needed — this page updates automatically.";
  }
  return "This is taking longer than usual. Your funds are safe — leave this page open or check Orders for updates.";
}

export function swapRecordingProofHint(elapsedSec: number): string {
  if (elapsedSec < 45) {
    return "Loop confirmed your signature. WarpX is recording the CBTC delivery proof on Canton…";
  }
  if (elapsedSec < 120) {
    return "Still confirming your CBTC delivery on Canton. Leave this page open — it updates automatically.";
  }
  return "Canton proof is slow to appear. Refresh or reopen from Orders if this does not advance soon.";
}

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
