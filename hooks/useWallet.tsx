"use client";

import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useLoopWallet, type LoopProvider } from "@/hooks/useLoopWallet";

/**
 * App identity hook. The Canton party now comes from the user's CONNECTED LOOP
 * WALLET (useLoopWallet), not from a validator-created party. On connect we
 * register that party against the Supabase session (party_mappings) so the
 * server can resolve "which party does this session own" for read queries.
 *
 * The shape (isConnected/partyId/email/isLoading) is unchanged so every existing
 * consumer (dashboard, mint, redeem, balance, TopNav) keeps working — they just
 * now get the Loop party. `provider` is added for screens that need to submit a
 * user-signed Canton transaction via the Loop wallet.
 */

export type { LoopProvider } from "@/hooks/useLoopWallet";

interface WalletState {
  /** True once a Loop wallet is connected AND registered to the session. */
  isConnected: boolean;
  /** The connected Loop wallet's Canton party (the user's identity). */
  partyId: string;
  email: string | null;
  isLoading: boolean;
  /** Loop connect/logout passthrough so the UI can drive connection. */
  connectLoop: () => Promise<void>;
  logoutLoop: () => void;
  loopReady: boolean;
  loopConnecting: boolean;
  loopError: string | null;
  /**
   * The live Loop SDK provider — for screens that need USER-SIGNED reads/actions
   * (e.g. signing the "Exchange API Key" message to check the cBTC auto-accept
   * gate and read delivery history). Null until connected. Every action through
   * it is approved by the user in their Loop wallet (no private key leaves the
   * wallet, no server authority over the user).
   */
  provider: LoopProvider | null;
}

const WalletContext = createContext<WalletState>({
  isConnected: false, partyId: "", email: null, isLoading: true,
  connectLoop: async () => {}, logoutLoop: () => {},
  loopReady: false, loopConnecting: false, loopError: null,
  provider: null,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const loop = useLoopWallet();
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Track the Supabase session email (app still uses Supabase for login/session).
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    void supabase.auth.getUser().then(({ data }) => setSessionEmail(data.user?.email ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSessionEmail(session?.user?.email ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // NOTE: Loop JWT/session registration is deliberately not minted here. Login
  // and swap flows trigger the one wallet signature explicitly; this provider
  // only exposes the connected wallet state so page loads never spam prompts.
  const partyId = loop.party;

  // Logout: drop the Loop wallet AND clear the server-side swap JWT session, so
  // a different account that connects next doesn't inherit the prior JWT cookie.
  const logoutLoop = useCallback(() => {
    void (async () => {
      try {
        const { clearSwapSession } = await import("@/lib/swap-accept");
        await clearSwapSession();
      } catch {
        /* ignore — logging out anyway */
      }
    })();
    loop.logout();
  }, [loop]);

  const value: WalletState = {
    isConnected: loop.connected && !!partyId,
    partyId,
    email: loop.email ?? sessionEmail,
    // restoring: a stored Loop session is still being silently re-established on
    // page load — callers (e.g. the /swap login gate) must wait, not redirect.
    isLoading: !loop.ready || loop.connecting || loop.restoring,
    connectLoop: loop.connect,
    logoutLoop,
    loopReady: loop.ready,
    loopConnecting: loop.connecting,
    loopError: loop.error,
    provider: loop.provider,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  return useContext(WalletContext);
}
