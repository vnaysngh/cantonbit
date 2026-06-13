"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";

/**
 * EVM (MetaMask / EIP-1193) wallet — dependency-free, app-wide via context.
 *
 * Used for the swap's EVM leg: connect an account, sign the Permit2 typed data,
 * send an `approve` tx, switch chain. Exposed app-wide (header + swap page share
 * one connection) through EvmWalletProvider, so the header can show a connect/
 * disconnect pill alongside the Loop wallet.
 */

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

export interface EvmWallet {
  available: boolean;
  account: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  signTypedData: (typedData: object) => Promise<string>;
  sendTransaction: (tx: { to: string; data: string; value?: string }) => Promise<string>;
  call: (to: string, data: string) => Promise<string>;
  switchChain: (chainId: number, params?: AddChainParams) => Promise<void>;
  /** Forget the connection in-app (the wallet itself stays installed). */
  disconnect: () => void;
}

export interface AddChainParams {
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

/** localStorage flag: the user explicitly disconnected, so don't auto-rehydrate. */
const DISCONNECTED_KEY = "oranj.evm.disconnected";

const EvmContext = createContext<EvmWallet | null>(null);

function useEvmWalletState(): EvmWallet {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnected = useRef(false);
  // `available` starts false (SSR-safe — window.ethereum doesn't exist on the
  // server) and is set to its real value in the effect, so the first client
  // render matches the server and there's no hydration mismatch.
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(!!getProvider());
    try { disconnected.current = localStorage.getItem(DISCONNECTED_KEY) === "1"; } catch { /* ignore */ }
    const p = getProvider();
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accts = args[0] as string[];
      const next = disconnected.current ? null : (accts?.[0] ?? null);
      setAccount(next);
      if (!next) setChainId(null);
    };
    const onChain = (...args: unknown[]) => {
      const cid = args[0] as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    // Hydrate current state if already authorized AND not manually disconnected.
    if (!disconnected.current) {
      void p.request({ method: "eth_accounts" }).then((a) => {
        const accts = a as string[];
        if (accts?.[0]) {
          setAccount(accts[0]);
          void p.request({ method: "eth_chainId" }).then((c) => {
            setChainId(c ? Number.parseInt(c as string, 16) : null);
          });
        } else {
          setChainId(null);
        }
      });
    }
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const p = getProvider();
    if (!p) { setError("No EVM wallet found. Install MetaMask."); return; }
    setConnecting(true);
    setError(null);
    try {
      disconnected.current = false;
      try { localStorage.removeItem(DISCONNECTED_KEY); } catch { /* ignore */ }
      const accts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accts?.[0] ?? null);
      const cid = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    disconnected.current = true;
    try { localStorage.setItem(DISCONNECTED_KEY, "1"); } catch { /* ignore */ }
    setAccount(null);
    setChainId(null);
    setError(null);
  }, []);

  const signTypedData = useCallback(async (typedData: object): Promise<string> => {
    const p = getProvider();
    if (!p || !account) throw new Error("wallet not connected");
    const sig = await p.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)],
    });
    return sig as string;
  }, [account]);

  const sendTransaction = useCallback(async (tx: { to: string; data: string; value?: string }): Promise<string> => {
    const p = getProvider();
    if (!p || !account) throw new Error("wallet not connected");
    const hash = await p.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: tx.to, data: tx.data, value: tx.value ?? "0x0" }],
    });
    return hash as string;
  }, [account]);

  const call = useCallback(async (to: string, data: string): Promise<string> => {
    const p = getProvider();
    if (!p) throw new Error("no provider");
    const res = await p.request({ method: "eth_call", params: [{ to, data }, "latest"] });
    return res as string;
  }, []);

  const switchChain = useCallback(async (targetChainId: number, params?: AddChainParams): Promise<void> => {
    const p = getProvider();
    if (!p) throw new Error("no provider");
    const hexId = `0x${targetChainId.toString(16)}`;
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 4902 && params) {
        await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: hexId, ...params }] });
      } else {
        throw e;
      }
    }
  }, []);

  return { available, account, chainId, connecting, error, connect, signTypedData, sendTransaction, call, switchChain, disconnect };
}

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const value = useEvmWalletState();
  return <EvmContext.Provider value={value}>{children}</EvmContext.Provider>;
}

export function useEvmWallet(): EvmWallet {
  const ctx = useContext(EvmContext);
  if (!ctx) throw new Error("useEvmWallet must be used within EvmWalletProvider");
  return ctx;
}
