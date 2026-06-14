"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface ManagedPreapprovalState {
  ccEnabled: boolean;
  cbtcEnabled: boolean;
  ccTotal: string;
  ccMinToEnable: number;
  ccReadyForEnable: boolean;
  ccSubsidizedOnDevnet: boolean;
  cbtcInstrumentAdmin?: string;
  swap?: {
    ready: boolean;
    issues: string[];
    userLegKind?: string;
    solverLegKind?: string;
  };
}

async function fetchPreapprovalStatus(params?: {
  fromAsset?: string;
  toAsset?: string;
  inAmount?: string;
  outAmount?: string;
}): Promise<ManagedPreapprovalState | null> {
  const q = new URLSearchParams();
  if (params?.fromAsset) q.set("fromAsset", params.fromAsset);
  if (params?.toAsset) q.set("toAsset", params.toAsset);
  if (params?.inAmount) q.set("inAmount", params.inAmount);
  if (params?.outAmount) q.set("outAmount", params.outAmount);
  const suffix = q.toString() ? `?${q}` : "";
  const r = await fetch(`/api/parties/preapproval-status${suffix}`, {
    cache: "no-store"
  });
  if (r.status === 403) return null;
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Preapproval status (${r.status})`);
  }
  return (await r.json()) as ManagedPreapprovalState;
}

export function useManagedPreapproval(opts?: {
  enabled?: boolean;
  fromAsset?: string;
  toAsset?: string;
  inAmount?: string;
  outAmount?: string;
}) {
  const queryClient = useQueryClient();
  const [enabling, setEnabling] = useState(false);
  const [enablingCbtc, setEnablingCbtc] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const queryKey = [
    "managed-preapproval",
    opts?.fromAsset,
    opts?.toAsset,
    opts?.inAmount,
    opts?.outAmount
  ] as const;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    enabled: opts?.enabled !== false,
    queryFn: () =>
      fetchPreapprovalStatus({
        fromAsset: opts?.fromAsset,
        toAsset: opts?.toAsset,
        inAmount: opts?.inAmount,
        outAmount: opts?.outAmount
      }),
    staleTime: 15_000
  });

  const enableCc = useCallback(async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      const r = await fetch("/api/parties/enable-cc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAsset: opts?.fromAsset,
          toAsset: opts?.toAsset,
          inAmount: opts?.inAmount,
          outAmount: opts?.outAmount
        })
      });
      const j = (await r.json().catch(() => ({}))) as ManagedPreapprovalState & {
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `Enable CC failed (${r.status})`);
      await queryClient.invalidateQueries({ queryKey: ["managed-preapproval"] });
      await refetch();
      return j;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEnableError(msg);
      throw e;
    } finally {
      setEnabling(false);
    }
  }, [
    opts?.fromAsset,
    opts?.toAsset,
    opts?.inAmount,
    opts?.outAmount,
    queryClient,
    refetch
  ]);

  const enableCbtc = useCallback(async () => {
    setEnablingCbtc(true);
    setEnableError(null);
    try {
      const r = await fetch("/api/parties/enable-cbtc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAsset: opts?.fromAsset,
          toAsset: opts?.toAsset,
          inAmount: opts?.inAmount,
          outAmount: opts?.outAmount
        })
      });
      const j = (await r.json().catch(() => ({}))) as ManagedPreapprovalState & {
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `Enable CBTC failed (${r.status})`);
      await queryClient.invalidateQueries({ queryKey: ["managed-preapproval"] });
      await refetch();
      return j;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEnableError(msg);
      throw e;
    } finally {
      setEnablingCbtc(false);
    }
  }, [
    opts?.fromAsset,
    opts?.toAsset,
    opts?.inAmount,
    opts?.outAmount,
    queryClient,
    refetch
  ]);

  const enableAllPreapprovals = useCallback(async () => {
    setEnableError(null);
    try {
      const canEnableCc =
        data &&
        !data.ccEnabled &&
        (data.ccReadyForEnable || data.ccSubsidizedOnDevnet);
      if (canEnableCc) await enableCc();
      await refetch();
      await enableCbtc();
      await refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEnableError(msg);
      throw e;
    }
  }, [data, enableCc, enableCbtc, refetch]);

  const needsEnableCc = !!data && !data.ccEnabled;
  const needsEnableCbtc = !!data && !data.cbtcEnabled;
  const needsCcDeposit =
    !!data && !data.ccReadyForEnable && !data.ccSubsidizedOnDevnet;
  const swapBlocked =
    !!data?.swap &&
    !data.swap.ready &&
    (needsEnableCc || needsEnableCbtc || (data.swap.issues?.length ?? 0) > 0);

  return {
    data,
    isLoading,
    error: error instanceof Error ? error.message : null,
    enabling,
    enablingCbtc,
    enableError,
    needsEnableCc,
    needsEnableCbtc,
    needsCcDeposit,
    swapBlocked,
    enableCc,
    enableCbtc,
    enableAllPreapprovals,
    refetch
  };
}
