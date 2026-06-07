"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
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
  const [registeredParty, setRegisteredParty] = useState<string>("");
  const [registering, setRegistering] = useState(false);
  const registeredFor = useRef<string>(""); // guard: register each party once

  // Track the Supabase session email (app still uses Supabase for login/session).
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    void supabase.auth.getUser().then(({ data }) => setSessionEmail(data.user?.email ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSessionEmail(session?.user?.email ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // When the Loop wallet connects, register its party against the session.
  useEffect(() => {
    if (!loop.connected || !loop.party) {
      setRegisteredParty("");
      registeredFor.current = "";
      return;
    }
    if (registeredFor.current === loop.party) return; // already registered this party
    registeredFor.current = loop.party;
    setRegistering(true);
    void (async () => {
      try {
        const res = await fetch("/api/parties/register-loop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ partyId: loop.party }),
        });
        const data = (await res.json()) as { partyId?: string; error?: string };
        if (res.ok && data.partyId) {
          setRegisteredParty(data.partyId);
        } else {
          // Registration failed (e.g. not logged in, or party owned by another
          // account). Still expose the Loop party for read-only client use, but
          // mark as unregistered so server actAs routes can reject if needed.
          console.error("[useWallet] loop party registration failed:", data.error);
          setRegisteredParty(loop.party);
        }
      } catch (err) {
        console.error("[useWallet] register-loop error:", err);
        setRegisteredParty(loop.party);
      } finally {
        setRegistering(false);
      }
    })();
  }, [loop.connected, loop.party]);

  // NOTE: the swap's Loop JWT session is NOT minted here at connect — it's a
  // prerequisite the SWAP SCREEN establishes (one "Exchange API Key" signature)
  // when the user actually goes to swap. Minting at connect would prompt every
  // user app-wide (dashboard/mint/redeem) for a signature they may not need. We
  // only CLEAR the session here on logout (below), so a different account that
  // connects next doesn't inherit the prior JWT cookie.

  const partyId = registeredParty || loop.party;

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
    isLoading: !loop.ready || loop.connecting || registering,
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
