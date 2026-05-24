"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { loop } from "@fivenorth/loop-sdk";

import { NETWORK } from "@/lib/constants";

// `Provider` is not part of the SDK's public type surface (only its class
// instance is exported via `loop`). We derive the type from the onAccept
// callback signature so we don't depend on a subpath import.
type LoopInitArg = Parameters<typeof loop.init>[0];
type Provider = NonNullable<LoopInitArg["onAccept"]> extends (
  p: infer P,
) => unknown
  ? P
  : never;
export type LoopProvider = Provider;

interface WalletState {
  isConnected: boolean;
  partyId: string | null;
  provider: Provider | null;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

interface WalletProviderProps {
  children: ReactNode;
  appName?: string;
}

export function WalletProvider({
  children,
  appName = "cantonbit",
}: WalletProviderProps) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    // Guard against React StrictMode double-effect in dev.
    if (initialized.current) return;
    initialized.current = true;

    loop.init({
      appName,
      network: NETWORK.loopNetwork,
      onAccept: (p) => {
        setProvider(p);
        setIsConnecting(false);
      },
      onReject: () => {
        setIsConnecting(false);
      },
      onTransactionUpdate: (payload) => {
        // Tasks 9/12/13 will route this into per-screen state. Logging for now
        // so we can see updates land during development.
        console.log("[loop] transaction update:", payload);
      },
      options: { openMode: "popup", requestSigningMode: "popup" },
    });

    // Revive an existing session if the user already connected previously.
    // autoConnect throws in two normal cases:
    //   1. No session in localStorage (first visit).
    //   2. The cached session's authToken no longer verifies against the
    //      Loop backend (stale token, environment mismatch, GC'd server-side).
    //
    // The SDK only auto-clears storage on 401/403. A 404 from verifySession
    // leaves the bad entry in place and the same noisy console.error fires
    // on every subsequent reload. We catch here and force-clear so the user
    // gets a clean disconnected state without a recurring error.
    loop.autoConnect().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const isStaleSession =
        msg.includes("Session verification failed") ||
        msg.includes("Invalid session");
      if (isStaleSession) {
        try {
          loop.logout();
        } catch {
          // logout is best-effort; if even that fails, nuke the key directly.
          try {
            window.localStorage.removeItem("loop_connect");
          } catch {
            // ignore — private browsing, etc.
          }
        }
      }
      // Either way, user will click Connect to start a fresh session.
    });
  }, [appName]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      await loop.connect();
      // onAccept will fire and set provider + clear isConnecting.
      // If the user closes the modal without approving, onReject clears it.
    } catch (err) {
      setIsConnecting(false);
      throw err;
    }
  }, []);

  const disconnect = useCallback(() => {
    loop.logout();
    setProvider(null);
  }, []);

  const value: WalletState = {
    isConnected: provider !== null,
    partyId: provider?.party_id ?? null,
    provider,
    isConnecting,
    connect,
    disconnect,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return ctx;
}
