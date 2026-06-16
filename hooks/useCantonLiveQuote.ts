"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { CantonSwapAssetId } from "@/lib/canton-assets";
import { formatCantonQuoteError } from "@/lib/canton-quote-messages";

/** Debounced live RFQ for same-Canton pairs (shown in "You receive" before Review). */
export function useCantonLiveQuote(opts: {
  enabled: boolean;
  fromAsset: CantonSwapAssetId | null;
  toAsset: CantonSwapAssetId | null;
  amount: string;
}) {
  const { enabled, fromAsset, toAsset, amount } = opts;
  const [debouncedAmount, setDebouncedAmount] = useState(amount);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 300);
    return () => clearTimeout(t);
  }, [amount]);

  const n = parseFloat(debouncedAmount);
  const amountOk =
    debouncedAmount.length > 0 && Number.isFinite(n) && n > 0;

  return useQuery({
    queryKey: ["c2c-live-quote", fromAsset, toAsset, debouncedAmount],
    queryFn: async () => {
      const r = await fetch("/api/canton/swap/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAsset,
          toAsset,
          amount: debouncedAmount
        })
      });
      const j = (await r.json()) as { outAmount?: string; error?: string };
      if (!r.ok) throw new Error(formatCantonQuoteError(j.error));
      return j;
    },
    enabled:
      enabled &&
      !!fromAsset &&
      !!toAsset &&
      fromAsset !== toAsset &&
      amountOk,
    staleTime: 25_000,
    placeholderData: keepPreviousData,
    retry: false
  });
}
