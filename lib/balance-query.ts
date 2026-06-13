import type { QueryClient } from "@tanstack/react-query";

/** Root key for all balance queries — invalidate this after any ledger write. */
export const BALANCE_QUERY_ROOT = ["balance"] as const;

export function balanceQueryKey(partyOrSession: string | null | undefined) {
  return [...BALANCE_QUERY_ROOT, partyOrSession ?? "session"] as const;
}

/** Refetch CBTC + CC balances everywhere (TopNav, swap card, account page). */
export function invalidateBalances(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: BALANCE_QUERY_ROOT });
}
