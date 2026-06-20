/** User-safe copy for settlement / registry failures (C2C + HTLC). */

export function formatSettlementError(raw: string | undefined): string {
  if (!raw?.trim()) {
    return "Settlement temporarily unavailable. Your funds are safe — we'll retry automatically.";
  }
  const m = raw.toLowerCase();
  if (
    m.includes("transferfactory") ||
    m.includes("scan nodes") ||
    m.includes("failed to reach consensus") ||
    m.includes("registry call failed (502")
  ) {
    return "Canton registry is temporarily unavailable. Your locked funds are safe — we're retrying automatically. Check Orders for status.";
  }
  if (m.includes("network fee not collected")) {
    return "Pay the Canton network fee in Loop first, then try again.";
  }
  if (m.includes("insufficient cc") && m.includes("network fee")) {
    return raw.trim();
  }
  if (raw.length <= 160 && !raw.includes("::")) {
    return raw.trim();
  }
  return "Something went wrong during settlement. Your funds are safe — check Orders or try again shortly.";
}

export function reverseSolverWaitDetail(chainName: string): string {
  return `Your CBTC is locked. Waiting for the solver to lock WBTC on ${chainName}.`;
}
