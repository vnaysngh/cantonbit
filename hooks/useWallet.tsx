"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type LoopProvider = null;

interface WalletState {
  isConnected: boolean;
  partyId: string;
  email: string | null;
  isLoading: boolean;
}

const WalletContext = createContext<WalletState>({
  isConnected: false,
  partyId: "",
  email: null,
  isLoading: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    isConnected: false,
    partyId: "",
    email: null,
    isLoading: true,
  });

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setState({ isConnected: false, partyId: "", email: null, isLoading: false });
        return;
      }

      // Allocate or fetch the Canton party for this user.
      // Idempotent — safe to call on every page load.
      try {
        const res = await fetch("/api/parties/allocate", { method: "POST" });
        const data = await res.json() as { partyId?: string; error?: string };

        if (data.partyId) {
          setState({
            isConnected: true,
            partyId: data.partyId,
            email: user.email ?? null,
            isLoading: false,
          });
        } else {
          console.error("[useWallet] party allocation failed:", data.error);
          setState({ isConnected: false, partyId: "", email: user.email ?? null, isLoading: false });
        }
      } catch (err) {
        console.error("[useWallet] party allocation error:", err);
        setState({ isConnected: false, partyId: "", email: user.email ?? null, isLoading: false });
      }
    };

    init();

    // Re-run when auth state changes (login/logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      init();
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <WalletContext.Provider value={state}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  return useContext(WalletContext);
}
