"use client";
import { createContext, useContext, type ReactNode } from "react";
import { NETWORK } from "@/lib/constants";

// LoopProvider is no longer used — all transactions go through the server-side
// m2m JWT on the WarpX party. Kept as a named export so existing import sites
// that reference the type compile without changes.
export type LoopProvider = null;

interface WalletState {
  isConnected: boolean;
  partyId: string;
}

const WalletContext = createContext<WalletState>({
  isConnected: true,
  partyId: NETWORK.warpxPartyId,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WalletContext.Provider value={{ isConnected: true, partyId: NETWORK.warpxPartyId }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  return useContext(WalletContext);
}
