"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { ChainIcon } from "@/components/ChainIcon";
import { TokenIcon, type SwapTokenId } from "@/components/TokenIcon";
import {
  CANTON_SWAP_ASSET_FALLBACK,
  type CantonSwapAssetMeta
} from "@/hooks/useCantonSwapAssets";
import type { SwapChain, SwapLeg } from "@/lib/swap-leg";
import type { SwapFeatureFlags } from "@/lib/swap-leg";
import {
  crossChainPickerHint,
  legDisplay,
  swapLegPickerDisabled
} from "@/lib/swap-leg";
import { SWAP_CHAIN, type SwapChain as HtlcEvmChain } from "@/lib/swap-evm";
import { cn } from "@/lib/utils";

type NetworkFilter = "all" | "canton" | `evm:${string}`;

type TokenRow = {
  leg: SwapLeg;
  symbol: string;
  name: string;
  network: string;
  evmChainSlug?: string;
  disabled: boolean;
};

export function SwapLegBadge({
  leg,
  otherLeg,
  onChange,
  cantonAssets,
  getBalance,
  disabled,
  evmNetworkName,
  evmChains,
  selectedEvmChainSlug,
  onEvmChainSelect,
  swapFeatureFlags
}: {
  leg: SwapLeg;
  otherLeg?: SwapLeg;
  onChange: (leg: SwapLeg) => void;
  cantonAssets: CantonSwapAssetMeta[];
  getBalance?: (leg: SwapLeg) => string | undefined;
  disabled?: boolean;
  evmNetworkName?: string;
  evmChains?: HtlcEvmChain[];
  selectedEvmChainSlug?: string;
  onEvmChainSelect?: (slug: string) => void;
  swapFeatureFlags?: SwapFeatureFlags;
}) {
  const [open, setOpen] = useState(false);
  const { token, network } = legDisplay(leg);
  const selectedEvmChain =
    leg.chain === "evm" && selectedEvmChainSlug
      ? evmChains?.find((chain) => chain.slug === selectedEvmChainSlug)
      : undefined;
  const displayNetwork =
    leg.chain === "evm"
      ? (selectedEvmChain?.name ?? evmNetworkName ?? network)
      : network;
  const tokenId: SwapTokenId = leg.chain === "evm" ? "WBTC" : leg.token;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex shrink-0 items-center gap-2 rounded-2xl bg-card py-1 pl-1 pr-2.5 ring-1 ring-foreground/10 transition-colors hover:bg-muted/50",
          disabled && "pointer-events-none opacity-60"
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="relative inline-flex">
          <TokenIcon token={tokenId} size="md" />
          <ChainIcon
            network={displayNetwork}
            className="absolute -bottom-0.5 -right-0.5 size-3.5 ring-2 ring-card"
          />
        </span>
        <div className="leading-tight text-left">
          <div className="flex items-center gap-0.5 text-base font-semibold text-foreground">
            {token}
            <span className="material-symbols-outlined text-[18px] text-muted-foreground">
              expand_more
            </span>
          </div>
          {leg.chain === "evm" && (
            <div className="max-w-[7rem] truncate text-[10px] font-medium text-muted-foreground">
              {displayNetwork}
            </div>
          )}
        </div>
      </button>

      {open && (
        <SwapTokenSelectModal
          leg={leg}
          otherLeg={otherLeg}
          cantonAssets={cantonAssets}
          getBalance={getBalance}
          evmNetworkName={evmNetworkName}
          evmChains={evmChains}
          selectedEvmChainSlug={selectedEvmChainSlug}
          onEvmChainSelect={onEvmChainSelect}
          swapFeatureFlags={swapFeatureFlags}
          onClose={() => setOpen(false)}
          onSelect={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SwapTokenSelectModal({
  leg,
  otherLeg,
  cantonAssets,
  getBalance,
  evmNetworkName,
  evmChains,
  selectedEvmChainSlug,
  onEvmChainSelect,
  onClose,
  onSelect,
  swapFeatureFlags
}: {
  leg: SwapLeg;
  otherLeg?: SwapLeg;
  cantonAssets: CantonSwapAssetMeta[];
  getBalance?: (leg: SwapLeg) => string | undefined;
  evmNetworkName?: string;
  evmChains?: HtlcEvmChain[];
  selectedEvmChainSlug?: string;
  onEvmChainSelect?: (slug: string) => void;
  onClose: () => void;
  onSelect: (leg: SwapLeg) => void;
  swapFeatureFlags?: SwapFeatureFlags;
}) {
  const availableEvmChains =
    evmChains && evmChains.length > 0
      ? evmChains
      : [
          {
            slug: SWAP_CHAIN.slug,
            id: SWAP_CHAIN.id,
            name: evmNetworkName ?? SWAP_CHAIN.name,
            wbtc: SWAP_CHAIN.wbtc,
            escrow: SWAP_CHAIN.escrow,
            rpcUrls: SWAP_CHAIN.rpcUrls,
            blockExplorerUrls: SWAP_CHAIN.blockExplorerUrls,
            nativeCurrency: SWAP_CHAIN.nativeCurrency
          }
        ];
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<NetworkFilter>(() =>
    leg.chain === "evm"
      ? `evm:${selectedEvmChainSlug ?? availableEvmChains[0]?.slug ?? SWAP_CHAIN.slug}`
      : "canton"
  );
  const [mounted, setMounted] = useState(false);

  const cantonList =
    cantonAssets.length > 0 ? cantonAssets : CANTON_SWAP_ASSET_FALLBACK;
  const crossChainHint = crossChainPickerHint(otherLeg, leg);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: TokenRow[] = [];

    if (network === "all" || network === "canton") {
      for (const a of cantonList) {
        if (
          q &&
          !a.symbol.toLowerCase().includes(q) &&
          !a.label.toLowerCase().includes(q)
        ) {
          continue;
        }
        const candidate = { chain: "canton", token: a.id } as SwapLeg;
        out.push({
          leg: candidate,
          symbol: a.symbol,
          name: a.label,
          network: "Canton",
          disabled: swapLegPickerDisabled(candidate, otherLeg, swapFeatureFlags)
        });
      }
    }

    for (const chain of availableEvmChains) {
      if (network !== "all" && network !== `evm:${chain.slug}`) continue;
      if (
        q &&
        !"wbtc".includes(q) &&
        !"wrapped".includes(q) &&
        !"bitcoin".includes(q) &&
        !chain.name.toLowerCase().includes(q)
      ) {
        continue;
      }
      const candidate = { chain: "evm", token: "WBTC" } as SwapLeg;
      out.push({
        leg: candidate,
        symbol: "WBTC",
        name: "Wrapped Bitcoin",
        network: chain.name,
        evmChainSlug: chain.slug,
        disabled: swapLegPickerDisabled(candidate, otherLeg, swapFeatureFlags)
      });
    }

    return out;
  }, [availableEvmChains, cantonList, network, otherLeg, query]);

  if (!mounted || typeof document === "undefined") return null;

  const modal = (
    <div className="fixed inset-0 z-[100]" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select a token"
        className="absolute bottom-4 left-1/2 z-10 flex max-h-[min(640px,90dvh)] w-[min(calc(100vw-2rem),440px)] -translate-x-1/2 flex-col overflow-hidden rounded-3xl border border-foreground/10 bg-card shadow-2xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
      >
        <div className="flex items-center justify-between border-b border-foreground/5 px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">
            Select a token
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="space-y-3 px-4 pt-3">
          {crossChainHint && (
            <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800">
              {crossChainHint}
            </p>
          )}

          <div className="relative">
            <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-muted-foreground">
              search
            </span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or symbol"
              className="w-full rounded-2xl border border-foreground/10 bg-muted/30 py-2.5 pl-10 pr-3 text-sm outline-none ring-primary/30 focus:ring-2"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { id: "all" as const, label: "All networks" },
              { id: "canton" as const, label: "Canton" },
              ...availableEvmChains.map((chain) => ({
                id: `evm:${chain.slug}` as const,
                label: chain.name
              }))
            ].map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setNetwork(n.id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  network === n.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[min(420px,50dvh)] overflow-y-auto px-2 pb-4 pt-3">
          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No tokens match your search
            </p>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((row) => {
                const tokenId: SwapTokenId =
                  row.leg.chain === "evm" ? "WBTC" : row.leg.token;
                const bal =
                  row.leg.chain === "evm" &&
                  row.evmChainSlug &&
                  selectedEvmChainSlug &&
                  row.evmChainSlug !== selectedEvmChainSlug
                    ? undefined
                    : getBalance?.(row.leg);
                const active =
                  !row.disabled &&
                  leg.chain === row.leg.chain &&
                  ((leg.chain === "evm" &&
                    row.evmChainSlug === selectedEvmChainSlug) ||
                    (leg.chain === "canton" &&
                      row.leg.chain === "canton" &&
                      leg.token === row.leg.token));
                const disabled = row.disabled;

                return (
                  <li
                    key={`${row.leg.chain}-${row.symbol}-${row.evmChainSlug ?? row.network}`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (disabled) return;
                        if (row.leg.chain === "evm" && row.evmChainSlug) {
                          onEvmChainSelect?.(row.evmChainSlug);
                        }
                        onSelect(row.leg);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
                        disabled
                          ? "cursor-not-allowed opacity-45"
                          : "hover:bg-muted/60",
                        active && "bg-primary/8 ring-1 ring-primary/15"
                      )}
                    >
                      <span className="relative inline-flex shrink-0">
                        <TokenIcon token={tokenId} size="lg" />
                        <ChainIcon
                          network={row.network}
                          className="absolute -bottom-0.5 -right-0.5 size-4 ring-2 ring-card"
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">
                            {row.symbol}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {row.name}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {row.network}
                        </div>
                      </div>
                      {bal !== undefined && (
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-medium tabular-nums text-foreground">
                            {bal}
                          </div>
                        </div>
                      )}
                      {active && (
                        <span className="material-symbols-outlined text-[20px] text-primary">
                          check
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
