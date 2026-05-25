"use client";

import { useState } from "react";

import type { ActivityRow } from "@/lib/types";

interface TransfersState {
  activity: ActivityRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Activity / transfer history.
 *
 * Currently returns an empty list — transfer history requires indexing the
 * Canton transaction stream which is out of scope for the initial mint/redeem
 * app. The interface is kept intact so pages don't need to change when a real
 * implementation is added.
 *
 * Loop SDK usage has been removed; all Canton access goes through the server-
 * side m2m JWT on the WarpX party.
 */
export function useTransfers(): TransfersState {
  const [tick, setTick] = useState(0);
  void tick; // suppress unused-variable warning

  return {
    activity: [],
    isLoading: false,
    error: null,
    refetch: () => setTick((n) => n + 1),
  };
}
