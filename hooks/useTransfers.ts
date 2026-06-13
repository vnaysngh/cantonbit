"use client";

import { useQuery } from "@tanstack/react-query";

import type { ActivityRow } from "@/lib/types";
import { useCantonIdentity } from "./useCantonIdentity";

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
 * Works for email (session party) and Loop users once party is known.
 */
export function useTransfers(): TransfersState {
  const { party, ready } = useCantonIdentity();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["activity", party ?? "none"],
    enabled: ready && !!party,
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
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false
  });

  return {
    activity: data ?? [],
    isLoading,
    error: error instanceof Error ? error.message : null,
    refetch: () => void refetch()
  };
}
