"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * React Query provider — owns the singleton QueryClient for the whole app.
 *
 * Why useState (and not module-level new QueryClient()): in Next App Router
 * the layout can re-render across requests in some edge cases; useState
 * guarantees one client per browser session, never shared across users.
 *
 * Defaults are tuned for our use case: most data lives on Canton ledger or
 * the BitSafe attestor — both are external sources that can change anytime.
 * Stale-while-revalidate is the right shape: show what we have, refetch in
 * the background so the UI is always responsive.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is "fresh" for 30s — within that window navigations are
            // instant, no fetch. After that we still show cached and refetch.
            staleTime: 30_000,
            // Keep cache around for 5 min after last use (instant back-nav).
            gcTime: 5 * 60_000,
            // Refresh when the tab regains focus — picks up attestor changes.
            refetchOnWindowFocus: true,
            // Retry once on transient failures.
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
