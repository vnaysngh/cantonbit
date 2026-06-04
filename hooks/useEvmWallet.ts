"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Minimal EVM (MetaMask / EIP-1193) wallet hook — dependency-free.
 *
 * The swap flow needs the user to (1) connect an EVM account, (2) sign the
 * Permit2 typed data the solver returns, and (3) send an `approve` tx so Permit2
 * can pull WBTC. All via window.ethereum directly — no wagmi/viem in the app.
 *
 * Deliberately small: no chain switching UI, no multi-wallet. It exposes the
 * account, the chainId, and thin request helpers the page composes.
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
  /** Sign EIP-712 typed data (eth_signTypedData_v4). Returns the 0x signature. */
  signTypedData: (typedData: object) => Promise<string>;
  /** Send a raw transaction (e.g. ERC20 approve). Returns the tx hash. */
  sendTransaction: (tx: { to: string; data: string; value?: string }) => Promise<string>;
  /** eth_call for reads (returns hex). */
  call: (to: string, data: string) => Promise<string>;
  /** Ask the wallet to switch to a chain (adds it if unknown). */
  switchChain: (chainId: number, params?: AddChainParams) => Promise<void>;
}

export interface AddChainParams {
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

export function useEvmWallet(): EvmWallet {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = typeof window !== "undefined" && !!getProvider();

  // React to account/chain changes from the wallet.
  useEffect(() => {
    const p = getProvider();
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accts = args[0] as string[];
      setAccount(accts?.[0] ?? null);
    };
    const onChain = (...args: unknown[]) => {
      const cid = args[0] as string;
      setChainId(cid ? Number.parseInt(cid, 16) : null);
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    // Hydrate current state if already authorized.
    void p.request({ method: "eth_accounts" }).then((a) => {
      const accts = a as string[];
      if (accts?.[0]) setAccount(accts[0]);
    });
    void p.request({ method: "eth_chainId" }).then((c) => {
      setChainId(c ? Number.parseInt(c as string, 16) : null);
    });
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
      // 4902 = chain not added to the wallet. Add it, then it becomes current.
      const code = (e as { code?: number })?.code;
      if (code === 4902 && params) {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hexId, ...params }],
        });
      } else {
        throw e;
      }
    }
  }, []);

  return { available, account, chainId, connecting, error, connect, signTypedData, sendTransaction, call, switchChain };
}
