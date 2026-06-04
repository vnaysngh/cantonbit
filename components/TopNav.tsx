"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useEffect, useRef, useState } from "react";

import { ChainIcon } from "@/components/ChainIcon";
import { useWallet } from "@/hooks/useWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { SWAP_CHAIN } from "@/lib/swap-evm";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/mint", label: "Mint" },
  // Send/Receive hidden for now — flows still in progress, mint+redeem are the primary user actions.
  // { href: "/send", label: "Send" },
  // { href: "/receive", label: "Receive" },
  { href: "/redeem", label: "Redeem" },
  { href: "/swap", label: "Swap" },
  { href: "/activity", label: "Activity" }
] as const;

export function TopNav() {
  const pathname = usePathname();
  const { partyId, connectLoop, logoutLoop, loopConnecting, loopReady } = useWallet();
  const evm = useEvmWallet();
  const evmWrongChain = evm.chainId != null && evm.chainId !== SWAP_CHAIN.id;

  // Click the wrong-network warning to switch the connected EVM provider to the
  // swap chain (Arbitrum). Adds the chain if the wallet doesn't have it.
  const handleEvmSwitch = () => {
    void evm.switchChain(SWAP_CHAIN.id, {
      chainName: SWAP_CHAIN.name,
      rpcUrls: SWAP_CHAIN.rpcUrls,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      blockExplorerUrls: SWAP_CHAIN.blockExplorerUrls,
    }).catch(() => {});
  };

  return (
    <header className="sticky top-0 z-50 border-b border-outline-variant bg-surface/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-container-padding">
        {/* Brand */}
        <Link href="/" aria-label="Oranj — home" className="flex items-center gap-2">
          <Image
            src="/logo.png"
            alt="Oranj"
            width={64}
            height={0}
            style={{ height: "auto" }}
            priority
          />
        </Link>

        {/* Center navigation */}
        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "text-body-md transition-colors",
                  active
                    ? "border-b-2 border-primary pb-1 text-primary"
                    : "text-on-surface-variant hover:text-on-surface"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Actions — a single Wallets dropdown */}
        <div className="flex items-center gap-3">
          <WalletsMenu
            evm={evm}
            evmWrongChain={evmWrongChain}
            onEvmSwitch={handleEvmSwitch}
            swapChainName={SWAP_CHAIN.name}
            party={partyId}
            connectLoop={connectLoop}
            logoutLoop={logoutLoop}
            loopConnecting={loopConnecting}
            loopReady={loopReady}
          />
        </div>
      </div>
    </header>
  );
}

/** A small EVM-wallet shape for the menu (subset of useEvmWallet). */
interface EvmLike {
  account: string | null;
  available: boolean;
  connecting: boolean;
  connect: () => void;
  disconnect: () => void;
}

/**
 * Single "Wallets" trigger that opens a dropdown listing both wallets (EVM +
 * Canton/Loop). Each row: the chain logo, the connection state, and a connect or
 * disconnect action. Replaces the cluttered row of three chips.
 */
function WalletsMenu({
  evm, evmWrongChain, onEvmSwitch, swapChainName,
  party, connectLoop, logoutLoop, loopConnecting, loopReady,
}: {
  evm: EvmLike;
  evmWrongChain: boolean;
  onEvmSwitch: () => void;
  swapChainName: string;
  party: string;
  connectLoop: () => void;
  logoutLoop: () => void;
  loopConnecting: boolean;
  loopReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"evm" | "canton" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const copy = (text: string, which: "evm" | "canton") => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const evmConnected = !!evm.account;
  const cantonConnected = !!party;
  const connectedCount = (evmConnected ? 1 : 0) + (cantonConnected ? 1 : 0);

  // Trigger label summarizes state without crowding the bar.
  const triggerLabel =
    connectedCount === 0 ? "Connect wallets"
    : evmWrongChain ? "Wrong network"
    : connectedCount === 2 ? "2 wallets"
    : "1 wallet";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg px-4 text-body-md transition-all hover:opacity-90 active:scale-95",
          evmWrongChain
            ? "bg-amber-500 text-white"
            : connectedCount > 0
              ? "border border-outline-variant bg-surface-container text-on-surface"
              : "bg-primary text-on-primary",
        )}
      >
        {connectedCount > 0 && !evmWrongChain && (
          <span className="flex items-center -space-x-1">
            {evmConnected && <span className="inline-block size-2 rounded-full bg-blue-500 ring-1 ring-surface-container" />}
            {cantonConnected && <span className="inline-block size-2 rounded-full bg-primary ring-1 ring-surface-container" />}
          </span>
        )}
        {triggerLabel}
        <span className="material-symbols-outlined text-[18px]">{open ? "expand_less" : "expand_more"}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-outline-variant bg-surface p-2 shadow-lg">
          <WalletRow
            label="EVM (Arbitrum)"
            network="Arbitrum"
            connected={evmConnected}
            address={evm.account ?? undefined}
            copied={copied === "evm"}
            warn={evmWrongChain}
            warnAction={{ label: `Switch to ${swapChainName}`, onClick: onEvmSwitch }}
            onCopy={() => evm.account && copy(evm.account, "evm")}
            onConnect={evm.connect}
            connectLabel={evm.connecting ? "Connecting…" : evm.available ? "Connect" : "No wallet"}
            connectDisabled={evm.connecting || !evm.available}
            onDisconnect={evm.disconnect}
          />
          <div className="my-1 h-px bg-outline-variant/50" />
          <WalletRow
            label="Canton (Loop)"
            network="Canton"
            connected={cantonConnected}
            address={party || undefined}
            copied={copied === "canton"}
            onCopy={() => party && copy(party, "canton")}
            onConnect={connectLoop}
            connectLabel={loopConnecting ? "Connecting…" : loopReady ? "Connect" : "Loading…"}
            connectDisabled={loopConnecting || !loopReady}
            onDisconnect={logoutLoop}
          />
        </div>
      )}
    </div>
  );
}

/** One wallet row inside the WalletsMenu dropdown. */
function WalletRow({
  label, network, connected, address, copied, warn, warnAction,
  onCopy, onConnect, connectLabel, connectDisabled, onDisconnect,
}: {
  label: string;
  network: string;
  connected: boolean;
  address?: string;
  copied: boolean;
  warn?: boolean;
  warnAction?: { label: string; onClick: () => void };
  onCopy: () => void;
  onConnect: () => void;
  connectLabel: string;
  connectDisabled?: boolean;
  onDisconnect: () => void;
}) {
  const short = address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "";
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg p-2">
      <div className="flex min-w-0 items-center gap-3">
        {/* Chain logo — dimmed when that wallet isn't connected. */}
        <ChainIcon
          network={network}
          className={cn("size-5", !connected && "opacity-40 grayscale")}
        />
        <div className="min-w-0">
          <div className="text-[11px] leading-tight text-on-surface-variant">{label}</div>
          {connected ? (
            warn && warnAction ? (
              <button onClick={warnAction.onClick} className="whitespace-nowrap text-xs font-medium text-amber-600 hover:underline">
                {warnAction.label}
              </button>
            ) : (
              <button onClick={onCopy} className="whitespace-nowrap font-mono text-xs text-on-surface hover:opacity-70" title="Copy address">
                {copied ? "Copied!" : short}
              </button>
            )
          ) : (
            <div className="text-xs text-on-surface-variant">Not connected</div>
          )}
        </div>
      </div>
      {connected ? (
        <button
          onClick={onDisconnect}
          className="shrink-0 rounded-full p-1 text-on-surface-variant transition-all hover:bg-surface-container-high hover:text-on-surface"
          aria-label="Disconnect"
          title="Disconnect"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={connectDisabled}
          className="shrink-0 rounded-lg bg-primary px-3 py-1 text-label-md text-on-primary transition-all hover:opacity-90 disabled:opacity-50"
        >
          {connectLabel}
        </button>
      )}
    </div>
  );
}
