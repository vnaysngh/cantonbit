"use client";

import { useCallback, useEffect, useState } from "react";

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
 * Fetches `/api/activity`, which scans a fixed window of /v2/updates for the
 * authenticated user's party and classifies each transaction. Polls every
 * 30s while visible so newly accepted offers / completed mints show up
 * without a refresh.
 */
export function useTransfers(): TransfersState {
  const { partyId } = useWallet();

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      const data = (await res.json()) as {
        activity?: ActivityRow[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Activity fetch failed (${res.status})`);
      }
      setActivity(data.activity ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load — only show the spinner the first time so background polls
  // don't flash the empty state.
  useEffect(() => {
    if (!partyId) return;
    let cancelled = false;
    if (!hasLoadedOnce) setIsLoading(true);
    load().finally(() => {
      if (cancelled) return;
      setIsLoading(false);
      setHasLoadedOnce(true);
    });
    return () => {
      cancelled = true;
    };
    // hasLoadedOnce intentionally omitted — including it would cause an
    // extra fetch right after the first load completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, load]);

  // Background polling — pause when tab is hidden, refetch on focus.
  useEffect(() => {
    if (!partyId) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(() => void load(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [partyId, load]);

  return {
    activity,
    isLoading,
    error,
    refetch: () => void load(),
  };
}
