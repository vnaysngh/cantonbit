"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useEffect, useRef, useState } from "react";

import { ChainIcon } from "@/components/ChainIcon";
import { WarpXWordmark } from "@/components/WarpXWordmark";
import { useCantonIdentity } from "@/hooks/useCantonIdentity";
import { useWallet } from "@/hooks/useWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useBalance } from "@/hooks/useBalance";
import { SWAP_CHAIN } from "@/lib/swap-evm";
import { truncateEvmAddress, truncatePartyId } from "@/lib/party-display";
import { cn } from "@/lib/utils";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

// Primary nav — Account is shown for email (participant-managed) users only.
const BASE_NAV_LINKS = [
  { href: "/swap", label: "Swap" },
  { href: "/orders", label: "Orders" },
  { href: "/how-it-works", label: "How it works" }
] as const;

function NavLinks({ pathname }: { pathname: string }) {
  const { isManaged } = useCantonIdentity();
  const links = isManaged
    ? [
        BASE_NAV_LINKS[0],
        { href: "/balances", label: "Account" },
        ...BASE_NAV_LINKS.slice(1)
      ]
    : [...BASE_NAV_LINKS];

  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {links.map((link) => {
        const active =
          link.href === "/swap"
            ? pathname === "/swap" || pathname === "/"
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const evm = useEvmWallet();
  const evmWrongChain =
    !!evm.account && evm.chainId != null && evm.chainId !== SWAP_CHAIN.id;

  // Click the wrong-network warning to switch the connected EVM provider to the
  // swap chain (Arbitrum). Adds the chain if the wallet doesn't have it.
  const handleEvmSwitch = () => {
    void evm.switchChain(SWAP_CHAIN.id, {
      chainName: SWAP_CHAIN.name,
      rpcUrls: SWAP_CHAIN.rpcUrls,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      blockExplorerUrls: SWAP_CHAIN.blockExplorerUrls,
    }).catch(() => {
      /* evm.error is set in switchChain */
    });
  };

  return (
    <header className="sticky top-0 z-50 border-b border-outline-variant bg-surface/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center px-container-padding">
        {/* Brand — takes up left third */}
        <div className="flex flex-1 justify-start">
          <WarpXWordmark href="/swap" showBeta />
        </div>

        <NavLinks pathname={pathname} />

        {/* Actions — takes up right third, pushes to the right edge */}
        <div className="flex flex-1 items-center justify-end gap-3">
          <CcBalanceBadge />
          <WalletsMenu
            evm={evm}
            evmWrongChain={evmWrongChain}
            evmSwitching={evm.switchingChain}
            evmError={evm.error}
            onEvmSwitch={handleEvmSwitch}
            swapChainName={SWAP_CHAIN.name}
          />
          <LogoutControl />
        </div>
      </div>
    </header>
  );
}

/** CC (Amulet) balance for any connected Canton party (Loop or email). */
function CcBalanceBadge() {
  const { party, ready } = useCantonIdentity();
  const { ccTotal, isLoading } = useBalance();

  if (!ready || !party) return null;

  return (
    <div
      className="hidden items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container px-2.5 py-1.5 text-xs text-muted-foreground sm:flex"
      title="Canton Coin balance for network fees"
    >
      <span className="text-[11px] uppercase tracking-wide">CC</span>
      <span className="font-mono tabular-nums text-foreground">
        {isLoading && ccTotal === null ? "…" : (ccTotal ?? "0")}
      </span>
    </div>
  );
}

/** Header Log out (outside the dropdown) — clears session + Loop → /login. */
function LogoutControl() {
  const router = useRouter();
  const { logoutLoop } = useWallet();
  const { party, ready } = useCantonIdentity();

  if (ready && !party) {
    return (
      <Link
        href="/login"
        className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        Log in
      </Link>
    );
  }

  const logout = async () => {
    try { await createSupabaseBrowserClient().auth.signOut(); } catch { /* no session */ }
    try { logoutLoop(); } catch { /* not connected */ }
    router.push("/login");
    router.refresh();
  };

  return (
    <button
      onClick={logout}
      className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      Log out
    </button>
  );
}

/** A small EVM-wallet shape for the menu (subset of useEvmWallet). */
interface EvmLike {
  account: string | null;
  available: boolean;
  connecting: boolean;
  connect: () => void;
  disconnect: () => void | Promise<void>;
}

/**
 * Wallets dropdown — Canton party FIRST (the identity: read-only, copy only, the
 * user CANNOT disconnect it here — logout is the only way out), then the EVM
 * wallet (the subset: connect/disconnect for the WBTC leg). The trigger shows the
 * Canton party (the identity), so it's visible at a glance.
 */
function WalletsMenu({
  evm, evmWrongChain, evmSwitching, evmError, onEvmSwitch, swapChainName,
}: {
  evm: EvmLike;
  evmWrongChain: boolean;
  evmSwitching: boolean;
  evmError: string | null;
  onEvmSwitch: () => void;
  swapChainName: string;
}) {
  const { party, ready } = useCantonIdentity();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"canton" | "evm" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const copy = (text: string, which: "canton" | "evm") => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  // No identity yet — don't render the wallets trigger (LogoutControl shows "Log in").
  if (ready && !party) return null;

  const evmConnected = !!evm.account;
  const shortParty = party ? truncatePartyId(party) : "Loading…";
  const triggerLabel = evmSwitching
    ? "Switching network…"
    : evmWrongChain
      ? "Wrong network"
      : shortParty;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg px-4 font-mono text-sm transition-all hover:opacity-90 active:scale-95",
          evmWrongChain
            ? "bg-amber-500 font-sans text-white"
            : "border border-outline-variant bg-surface-container text-on-surface",
        )}
      >
        <span className="inline-block size-2 rounded-full bg-primary ring-1 ring-surface-container" />
        {triggerLabel}
        <span className="material-symbols-outlined text-[18px]">{open ? "expand_less" : "expand_more"}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-outline-variant bg-surface p-2 shadow-lg">
          {/* Canton party — the identity. Read-only: copy, but no disconnect. */}
          <WalletRow
            label="Canton party"
            network="Canton"
            connected={!!party}
            address={party ?? undefined}
            copied={copied === "canton"}
            readOnly
            onCopy={() => party && copy(party, "canton")}
            onConnect={() => {}}
            connectLabel=""
            onDisconnect={() => {}}
          />
          <div className="my-1 h-px bg-outline-variant/50" />
          {/* EVM wallet — the subset for the WBTC leg. Connect/disconnect here. */}
          <WalletRow
            label="EVM wallet"
            network={swapChainName}
            connected={evmConnected}
            address={evm.account ?? undefined}
            copied={copied === "evm"}
            warn={evmWrongChain}
            warnAction={{
              label: evmSwitching ? "Switching…" : `Switch to ${swapChainName}`,
              onClick: onEvmSwitch,
              disabled: evmSwitching,
            }}
            onCopy={() => evm.account && copy(evm.account, "evm")}
            onConnect={evm.connect}
            connectLabel={evm.connecting ? "Connecting…" : evm.available ? "Connect" : "No wallet"}
            connectDisabled={evm.connecting || !evm.available}
            onDisconnect={() => void evm.disconnect()}
          />
          {evmError && (
            <p className="px-2 pb-1 text-[11px] leading-snug text-destructive">{evmError}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** One wallet row inside the WalletsMenu dropdown. */
function WalletRow({
  label, network, connected, address, copied, warn, warnAction, readOnly,
  onCopy, onConnect, connectLabel, connectDisabled, onDisconnect,
}: {
  label: string;
  network: string;
  connected: boolean;
  address?: string;
  copied: boolean;
  warn?: boolean;
  warnAction?: { label: string; onClick: () => void; disabled?: boolean };
  /** Identity row (Canton party): copy only — no disconnect, no connect button. */
  readOnly?: boolean;
  onCopy: () => void;
  onConnect: () => void;
  connectLabel: string;
  connectDisabled?: boolean;
  onDisconnect: () => void;
}) {
  const short = address ? truncateEvmAddress(address) : "";
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
              <button
                type="button"
                onClick={warnAction.onClick}
                disabled={warnAction.disabled}
                className={cn(
                  "whitespace-nowrap text-xs font-medium text-amber-600 hover:underline",
                  warnAction.disabled && "cursor-wait opacity-70"
                )}
              >
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
      {readOnly ? null : connected ? (
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
