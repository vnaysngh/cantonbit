"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";

import { NETWORK } from "@/lib/constants";

/**
 * Loop network for wallet connect. Must match the network the SWAP SOLVER runs
 * on. Canton is per-network: a Loop party and a solver on different networks are
 * separate ledgers and cannot transact (this caused the earlier
 * UNKNOWN_INFORMEES when the app was on mainnet and the solver on devnet).
 *
 * Everything is devnet now, so this follows NETWORK.loopNetwork (devnet).
 * NEXT_PUBLIC_LOOP_NETWORK can force a specific value if ever needed.
 */
const LOOP_NETWORK = (process.env.NEXT_PUBLIC_LOOP_NETWORK ?? NETWORK.loopNetwork) as
  | "devnet" | "testnet" | "mainnet";

/**
 * Loop wallet connection — the app's Canton identity source.
 *
 * Wraps @fivenorth/loop-sdk (browser-only: it uses popups + websockets, so the
 * SDK is dynamically imported and only ever touched client-side). On connect,
 * the Loop wallet returns a Provider carrying the user's real Canton `party_id`
 * — that party becomes the identity used across the app (swap destination,
 * holdings, mint/redeem). Transactions the user must authorize (transfers,
 * accepting a swap delivery) are signed in their own Loop wallet, not by us.
 *
 * `provider` is the live SDK Provider — kept here so screens can call
 * provider.getHolding() / submitTransaction() when a user-signed action is
 * needed. It is null until connected.
 */

// The SDK's Provider type — we keep it loose (unknown-ish) to avoid pulling the
// SDK types into the bundle eagerly; the shape we rely on is asserted below.
export interface LoopProvider {
  party_id: string;
  public_key: string;
  email?: string;
  getHolding: () => Promise<unknown[]>;
  getAccount: () => Promise<unknown>;
  getActiveContracts: (params?: { templateId?: string; interfaceId?: string }) => Promise<unknown[]>;
  submitTransaction: (payload: unknown, options?: unknown) => Promise<unknown>;
  submitAndWaitForTransaction: (payload: unknown, options?: unknown) => Promise<unknown>;
}

interface LoopState {
  /** SDK loaded + init() called (ready to connect). */
  ready: boolean;
  /** A Loop wallet is connected and we have a party. */
  connected: boolean;
  /** Connection in progress (popup open). */
  connecting: boolean;
  /** The connected Canton party id, or "" if not connected. */
  party: string;
  email: string | null;
  /** The live SDK Provider (for user-signed txns), or null. */
  provider: LoopProvider | null;
  error: string | null;
  connect: () => Promise<void>;
  logout: () => void;
}

const LoopContext = createContext<LoopState>({
  ready: false, connected: false, connecting: false, party: "", email: null,
  provider: null, error: null,
  connect: async () => {}, logout: () => {},
});

const APP_NAME = "Oranj";

export function LoopWalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [provider, setProvider] = useState<LoopProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The `loop` singleton from the SDK, loaded once.
  const loopRef = useRef<{
    init: (cfg: unknown) => void;
    connect: () => Promise<void>;
    autoConnect: () => Promise<void>;
    logout: () => void;
  } | null>(null);

  // Load + init the SDK once on mount (client-only), then try autoConnect to
  // restore an existing session silently.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("@fivenorth/loop-sdk");
        if (cancelled) return;
        const loop = mod.loop as unknown as NonNullable<typeof loopRef.current>;
        loop.init({
          appName: APP_NAME,
          network: LOOP_NETWORK,
          onAccept: (p: unknown) => {
            // p is the SDK Provider; capture it as our identity.
            setProvider(p as LoopProvider);
            setConnecting(false);
            setError(null);
          },
          onReject: () => {
            setConnecting(false);
            setError("Connection rejected in the Loop wallet.");
          },
        });
        loopRef.current = loop;
        setReady(true);
        // Restore a prior session — but ONLY if one exists. The SDK stores its
        // session under "loop_connect"; calling autoConnect() with no stored
        // session makes the SDK hit its backend and log a 404 to the console.
        // Gate on the key so a fresh visitor sees no error noise.
        let hasSession = false;
        try { hasSession = !!localStorage.getItem("loop_connect"); } catch { /* ignore */ }
        if (hasSession) {
          try { await loop.autoConnect(); } catch { /* session expired/invalid — fine */ }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load Loop SDK");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const connect = useCallback(async () => {
    const loop = loopRef.current;
    if (!loop) { setError("Loop SDK not ready yet."); return; }
    setConnecting(true);
    setError(null);
    // Clear any stale session/ticket before a FRESH connect. Leftover
    // `loop_connect` from an earlier (e.g. devnet) connect can poison the new
    // handshake → "ticket invalid or expired" on the wallet side. A user click
    // means "connect fresh", so start clean.
    try { loop.logout(); } catch { /* ignore */ }
    try { localStorage.removeItem("loop_connect"); } catch { /* ignore */ }
    try {
      await loop.connect(); // opens the wallet popup; onAccept fires with the provider
    } catch (e) {
      setConnecting(false);
      setError(e instanceof Error ? e.message : "Failed to connect Loop wallet");
    }
  }, []);

  const logout = useCallback(() => {
    try { loopRef.current?.logout(); } catch { /* ignore */ }
    try { localStorage.removeItem("loop_connect"); } catch { /* ignore */ }
    setProvider(null);
    setError(null);
  }, []);

  const value: LoopState = {
    ready,
    connected: !!provider,
    connecting,
    party: provider?.party_id ?? "",
    email: provider?.email ?? null,
    provider,
    error,
    connect,
    logout,
  };

  return <LoopContext.Provider value={value}>{children}</LoopContext.Provider>;
}

export function useLoopWallet(): LoopState {
  return useContext(LoopContext);
}
