"use client";

import { useQuery } from "@tanstack/react-query";

import type { ActivityRow } from "@/lib/types";
import { useWallet } from "./useWallet";

interface TransfersState {
  activity: ActivityRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Background poll interval (ms) while the tab is visible. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Activity / transfer history derived from the Canton update stream.
 *
 * Backed by React Query — gives us caching, stale-while-revalidate, automatic
 * visibility-based pausing (polling stops when the tab is hidden), and
 * refetchOnWindowFocus. The 30s poll keeps newly accepted offers / completed
 * mints flowing in without a refresh.
 */
export function useTransfers(): TransfersState {
  const { partyId } = useWallet();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["activity", partyId],
    enabled: !!partyId,
    queryFn: async (): Promise<ActivityRow[]> => {
      const res = await fetch("/api/activity", { cache: "no-store" });
      const json = (await res.json()) as {
        activity?: ActivityRow[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error ?? `Activity fetch failed (${res.status})`);
      }
      return json.activity ?? [];
    },
    // refetchInterval pauses automatically when the tab is hidden — exactly
    // the visibility behavior the old hand-rolled poll implemented manually.
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  return {
    activity: data ?? [],
    isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch(),
  };
}
