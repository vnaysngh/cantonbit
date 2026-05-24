"use client";

import { useState } from "react";

import type { ActivityRow } from "@/lib/types";

interface TransfersState {
  activity: ActivityRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY: ActivityRow[] = [];

/**
 * Activity history hook.
 *
 * Currently returns an empty list. Real activity needs a server-side
 * derivation from the participant's transaction tree (subscribe to
 * /v2/updates/trees from a known offset, classify each tree event as
 * sent/received/minted/redeemed, persist client-visible state).
 *
 * Loop's provider does not expose a "list my history" endpoint, so we
 * either build the server-side feed or stay empty. Returning a stable
 * empty array keeps the dashboard's "View all" link honest until then.
 */
export function useTransfers(): TransfersState {
  // refetch is a no-op for now but kept so screens can wire it without
  // changing once we plug in the real source.
  const [, setTick] = useState(0);

  return {
    activity: EMPTY,
    isLoading: false,
    error: null,
    refetch: () => setTick((n) => n + 1),
  };
}
