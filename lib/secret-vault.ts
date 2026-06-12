/**
 * Per-browser secret vault — persists each swap's HTLC secret in localStorage,
 * keyed by swap id (the hashLock). This lets a swap be CLAIMED later (from /orders
 * or after a refresh) instead of being abandonable when the tab closes.
 *
 * Trust note: the secret stays on the USER's device only — never sent to our
 * server. That preserves the email/managed flow's property that the user controls
 * the reveal. Cleared once the swap reaches a terminal state.
 */
const KEY = "oranj.htlc.secrets.v1";

type Vault = Record<string, string>; // swapId(hashLock) → secret (0x-hex)

function read(): Vault {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Vault; }
  catch { return {}; }
}
function write(v: Vault): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* quota/SSR — ignore */ }
}

/** Store the secret for a swap (call right after generateSecret + createOrder). */
export function rememberSecret(swapId: string, secret: string): void {
  if (typeof window === "undefined") return;
  const v = read(); v[swapId] = secret; write(v);
}

/** Recover a swap's secret, or null if this browser never held it. */
export function recallSecret(swapId: string): string | null {
  if (typeof window === "undefined") return null;
  return read()[swapId] ?? null;
}

/** Drop a swap's secret once it's settled/refunded (housekeeping). */
export function forgetSecret(swapId: string): void {
  if (typeof window === "undefined") return;
  const v = read(); if (v[swapId]) { delete v[swapId]; write(v); }
}
