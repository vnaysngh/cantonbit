"use client";

import { useCallback } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { LoopVaultProvider, VaultRecallContext } from "@/lib/secret-vault";

type UseVaultContextArgs = {
  loopProvider?: LoopVaultProvider | null;
  evmAddress?: string | null;
  sessionUserId?: string | null;
  sessionPartyId?: string | null;
};

/** Shared vault recall context for /swap and /orders (Loop + Supabase + EVM binding). */
export function useVaultContext({
  loopProvider,
  evmAddress,
  sessionUserId,
  sessionPartyId,
}: UseVaultContextArgs) {
  return useCallback(async (): Promise<VaultRecallContext> => {
    let userId = sessionUserId;
    if (!userId) {
      try {
        const { data } = await createSupabaseBrowserClient().auth.getUser();
        userId = data.user?.id ?? null;
      } catch {
        /* ignore */
      }
    }
    return {
      loopProvider,
      evmAddress,
      sessionUserId: userId,
      sessionPartyId,
    };
  }, [loopProvider, evmAddress, sessionUserId, sessionPartyId]);
}
