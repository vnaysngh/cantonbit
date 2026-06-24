/** Only show "taking longer" copy after two minutes on the live swap status UI. */
export const SWAP_WAIT_EXTENDED_AFTER_SECONDS = 120;

export const SWAP_WAIT_POLL_MS = 4_000;

export type SwapWaitMode = "solver" | "locking" | "settling" | "finalize";

export function swapFinalizeHint(params: {
  elapsedSec: number;
  reverse?: boolean;
  chainName: string;
}): string {
  const { elapsedSec, reverse, chainName } = params;
  if (reverse) {
    if (elapsedSec < 30) {
      return "Your WBTC claim is confirmed. The solver is finishing the Canton leg — usually under a minute.";
    }
    if (elapsedSec < 120) {
      return "Still finalizing on Canton. Your WBTC is already claimed — no action needed from you.";
    }
    return "This is taking longer than usual. Your WBTC is safe — the solver is completing Canton settlement.";
  }
  if (elapsedSec < 30) {
    return `Your CBTC is delivered. The solver is claiming WBTC on ${chainName} — usually under a minute.`;
  }
  if (elapsedSec < 120) {
    return `Still waiting for the solver to settle WBTC on ${chainName}. Your CBTC is already yours — no wallet action needed.`;
  }
  return `Solver settlement on ${chainName} is taking longer than usual. Your CBTC is delivered — this page will update automatically when the on-chain claim completes.`;
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
