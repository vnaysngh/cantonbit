"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { invalidateBalances } from "@/lib/balance-query";

/** Call after a successful swap, transfer, or accept to refresh balances app-wide. */
export function useInvalidateBalances() {
  const queryClient = useQueryClient();
  return useCallback(() => invalidateBalances(queryClient), [queryClient]);
}
