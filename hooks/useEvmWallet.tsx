"use client";

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";

import {
  getBrowserEvmProvider,
  waitForEvmReceipt,
  type Eip1193Like,
} from "@/lib/evm-wait-receipt";

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
  return getBrowserEvmProvider() as Eip1193Provider | null;
}

export interface EvmWallet {
  available: boolean;
  /** False until the initial eth_accounts probe finishes (client-only). */
  hydrated: boolean;
  account: string | null;
  chainId: number | null;
  connecting: boolean;
  /** True while wallet_switchEthereumChain / wallet_addEthereumChain is in flight. */
  switchingChain: boolean;
  error: string | null;
  connect: () => Promise<void>;
  signTypedData: (typedData: object) => Promise<string>;
  sendTransaction: (tx: { to: string; data: string; value?: string }) => Promise<string>;
  /** Wait for a tx hash to be mined (and succeed) before treating it as done. */
  waitForReceipt: (hash: string, opts?: { timeoutMs?: number; pollMs?: number }) => Promise<void>;
  call: (to: string, data: string) => Promise<string>;
  switchChain: (chainId: number, params?: AddChainParams) => Promise<void>;
  /** Forget the connection in-app and revoke wallet permissions when supported. */
  disconnect: () => Promise<void>;
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

function readDisconnectedFlag(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function useEvmWalletState(): EvmWallet {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switchingChain, setSwitchingChain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnected = useRef(false);
  // `available` starts false (SSR-safe — window.ethereum doesn't exist on the
  // server) and is set to its real value in the effect, so the first client
  // render matches the server and there's no hydration mismatch.
  const [available, setAvailable] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAvailable(!!getProvider());
    try { disconnected.current = readDisconnectedFlag(); } catch { /* ignore */ }
    const p = getProvider();
    if (!p?.on) {
      setHydrated(true);
      return;
    }
    const onAccounts = (...args: unknown[]) => {
      const accts = args[0] as string[];
      const next = disconnected.current ? null : (accts?.[0] ?? null);
      setAccount(next);
      if (!next) setChainId(null);
    };
    const onChain = (...args: unknown[]) => {
      if (disconnected.current) return;
      const cid = args[0] as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    // Hydrate current state if already authorized AND not manually disconnected.
    if (!disconnected.current) {
      void p
        .request({ method: "eth_accounts" })
        .then((a) => {
          if (disconnected.current) return;
          const accts = a as string[];
          if (accts?.[0]) {
            setAccount(accts[0]);
            void p.request({ method: "eth_chainId" }).then((c) => {
              if (disconnected.current) return;
              setChainId(c ? Number.parseInt(c as string, 16) : null);
            });
          } else {
            setChainId(null);
          }
        })
        .finally(() => setHydrated(true));
    } else {
      setHydrated(true);
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
    const forcePicker = disconnected.current || readDisconnectedFlag();
    disconnected.current = false;
    try { localStorage.removeItem(DISCONNECTED_KEY); } catch { /* ignore */ }
    try {
      // After an explicit disconnect, ask the wallet to show the account picker again.
      // Revoke on disconnect handles MetaMask; requestPermissions covers wallets that
      // ignore revoke or where revoke is unsupported.
      if (forcePicker) {
        try {
          await p.request({
            method: "wallet_requestPermissions",
            params: [{ eth_accounts: {} }],
          });
        } catch (e) {
          if ((e as { code?: number })?.code === 4001) throw e;
        }
      }
      const accts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accts?.[0] ?? null);
      const cid = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    } catch (e) {
      disconnected.current = true;
      try { localStorage.setItem(DISCONNECTED_KEY, "1"); } catch { /* ignore */ }
      setAccount(null);
      setChainId(null);
      setError(e instanceof Error ? e.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    disconnected.current = true;
    try { localStorage.setItem(DISCONNECTED_KEY, "1"); } catch { /* ignore */ }
    setAccount(null);
    setChainId(null);
    setError(null);

    const p = getProvider();
    if (!p) return;

    try {
      await p.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Not all wallets implement revoke — local disconnect still applies.
    }
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

  /**
   * Wait for a tx to be MINED and succeed before treating it as done.
   * eth_sendTransaction returns the hash immediately (pre-mining), so recording a
   * claim/retake right away can race the chain — the API would verify a receipt that
   * doesn't exist yet. Polls eth_getTransactionReceipt; throws on revert or timeout.
   */
  const waitForReceipt = useCallback(
    async (
      hash: string,
      opts?: { timeoutMs?: number; pollMs?: number }
    ): Promise<void> => {
      const p = getProvider();
      if (!p) throw new Error("no provider");
      await waitForEvmReceipt(p as Eip1193Like, hash, opts);
    },
    []
  );

  const call = useCallback(async (to: string, data: string): Promise<string> => {
    const p = getProvider();
    if (!p) throw new Error("no provider");
    const res = await p.request({ method: "eth_call", params: [{ to, data }, "latest"] });
    return res as string;
  }, []);

  const switchChain = useCallback(async (targetChainId: number, params?: AddChainParams): Promise<void> => {
    const p = getProvider();
    if (!p) {
      const msg = "No EVM wallet found.";
      setError(msg);
      throw new Error(msg);
    }
    setSwitchingChain(true);
    setError(null);
    const hexId = `0x${targetChainId.toString(16)}`;
    try {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
      } catch (e) {
        const code = (e as { code?: number })?.code;
        if (code === 4902 && params) {
          await p.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hexId,
              chainName: params.chainName,
              rpcUrls: params.rpcUrls,
              nativeCurrency: params.nativeCurrency,
              blockExplorerUrls: params.blockExplorerUrls,
            }],
          });
        } else if (code === 4001) {
          throw new Error("Network switch cancelled.");
        } else {
          throw e;
        }
      }
      // chainChanged is unreliable (some wallets reload; others omit the event).
      // Always refresh from the provider so the UI updates without a full reload.
      const cid = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to switch network.";
      setError(msg);
      throw e instanceof Error ? e : new Error(msg);
    } finally {
      setSwitchingChain(false);
    }
  }, []);

  return {
    available,
    hydrated,
    account,
    chainId,
    connecting,
    switchingChain,
    error,
    connect,
    signTypedData,
    sendTransaction,
    waitForReceipt,
    call,
    switchChain,
    disconnect
  };
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
