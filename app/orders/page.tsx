"use client";

/**
 * /orders — swap history for the logged-in user (both directions).
 * Identity: email session (server resolves the warpx party from the cookie) or
 * the connected Loop wallet (party passed as a query param). Newest first.
 *
 * Production table view + a portal-rendered detail drawer (portal escapes any
 * ancestor containing-block so the drawer is never clipped/collapsed).
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useWallet } from "@/hooks/useWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useVaultContext } from "@/hooks/useVaultContext";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { claimSwap, evmRetake, fetchMergedSwapHistory, htlcApi } from "@/lib/htlc-client";
import { isSwapClaimable } from "@/lib/htlc-order-logic";
import type { SwapStatus } from "@/lib/htlc-types";
import {
  forgetSecret,
  hasStoredSecret,
  purgeExpiredSecrets,
  recallSecret,
  vaultMetaFromOrder,
} from "@/lib/secret-vault";
import { listLoopCbtcHoldingCids } from "@/lib/loop-holdings";
import { getSwapErrorMessage } from "@/lib/swap-api";
import { SWAP_CHAIN } from "@/lib/swap-evm";
import { cn } from "@/lib/utils";

const HTLC_ESCROW = process.env.NEXT_PUBLIC_HTLC_ESCROW ?? "0x1b19a764ab35db1833ae2137544dd84ba5bf8cf1";
const EVM_CHAIN = SWAP_CHAIN.name;

interface HistoryOrder {
  id: string;
  direction: "evm-to-canton" | "canton-to-evm";
  status: string;
  wbtcAmount: string;   // 8dp base units
  cbtcAmount: string;   // decimal string
  userEvmAddress?: string;
  userCantonParty?: string;
  solverCantonParty?: string;
  mainLockTx?: string;
  counterLockTx?: string;
  counterTransferUpdateId?: string;
  counterTransferOfferCid?: string;
  mainClaimTx?: string;
  counterClaimUpdateId?: string;
  allocationCid?: string;
  htlcCid?: string;
  createdAt: number;    // unix seconds
  counterMode?: string;
  userTimelock?: number;
  solverTimelock?: number;
  revealedPreimage?: string;
}

/** True if the user actually has funds locked that a refund/retake would return. */
function hasLockedFunds(o: HistoryOrder): boolean {
  if (o.direction === "evm-to-canton") return !!o.mainLockTx;            // user's WBTC on EVM
  return !!o.htlcCid || !!o.counterTransferUpdateId || !!o.allocationCid; // user's cBTC on Canton
}

function isClaimableOrder(o: HistoryOrder): boolean {
  return isSwapClaimable({
    status: o.status as SwapStatus,
    direction: o.direction,
    counterMode: o.counterMode === "loop" || o.counterMode === "managed" ? o.counterMode : undefined,
    revealedPreimage: o.revealedPreimage as `0x${string}` | undefined,
  });
}

/** Loop reverse: user signed the cBTC lock in Loop but confirm-lock-loop never ran (e.g. refresh). */
function needsLoopLockConfirm(o: HistoryOrder): boolean {
  return o.direction === "canton-to-evm" && o.counterMode === "loop" && o.status === "accepted";
}

/** Loop forward: secret revealed and cBTC offer sent, but user still owes a standard accept. */
function needsLoopAccept(o: HistoryOrder): boolean {
  return (
    o.direction === "evm-to-canton" &&
    o.counterMode === "loop" &&
    o.status === "counter_claimed" &&
    !!o.counterTransferOfferCid
  );
}

/** User leg done; waiting for the HTLC solver daemon to claim WBTC on EVM. */
function isAwaitingSolverFinalize(o: HistoryOrder): boolean {
  return o.direction === "evm-to-canton" && o.status === "counter_claimed";
}

/** What recovery action (if any) the user can take on a stuck order, NOW. Only
 *  shown when funds are ACTUALLY locked, the secret isn't revealed, and the user
 *  timelock has passed. (An 'accepted' order that never locked has nothing to refund.) */
function recoveryAction(o: HistoryOrder): "retake-wbtc" | "refund-cbtc" | null {
  const now = Math.floor(Date.now() / 1000);
  const live = o.status === "main_locked" || o.status === "counter_locked";
  if (!live || o.revealedPreimage || !hasLockedFunds(o)) return null;
  if (!o.userTimelock || now < o.userTimelock) return null;
  return o.direction === "evm-to-canton" ? "retake-wbtc" : "refund-cbtc";
}

const STATUS_STYLE: Record<string, string> = {
  main_claimed: "bg-green-500/12 text-green-600 ring-green-500/20",
  both_claimed: "bg-green-500/12 text-green-600 ring-green-500/20",
  counter_claimed: "bg-amber-500/12 text-amber-600 ring-amber-500/20",
  counter_locked: "bg-blue-500/12 text-blue-600 ring-blue-500/20",
  main_locked: "bg-blue-500/12 text-blue-600 ring-blue-500/20",
  accepted: "bg-foreground/8 text-foreground/60 ring-foreground/10",
  open: "bg-foreground/8 text-foreground/60 ring-foreground/10",
  refunded: "bg-foreground/8 text-foreground/55 ring-foreground/10",
  cancelled: "bg-foreground/8 text-foreground/55 ring-foreground/10",
  failed: "bg-red-500/12 text-red-600 ring-red-500/20",
};
const STATUS_LABEL: Record<string, string> = {
  open: "Open", accepted: "Pending", main_locked: "In progress",
  counter_locked: "Claimable", counter_claimed: "Settling",
  main_claimed: "Completed", both_claimed: "Completed", refunded: "Refunded",
  cancelled: "Cancelled", failed: "Failed",
};

function fmtWbtc(units: string): string {
  try { return (Number(BigInt(units)) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""); }
  catch { return units; }
}
function fmtCbtc(dec: string): string {
  const n = parseFloat(dec); return Number.isFinite(n) ? n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : dec;
}
function shortId(s?: string): string {
  return s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—";
}
function fmtTime(unix?: number): string {
  return unix ? new Date(unix * 1000).toLocaleString() : "—";
}
function fmtDateShort(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
      STATUS_STYLE[status] ?? "bg-foreground/8 text-foreground/60 ring-foreground/10",
    )}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** A small chain→chain pill pair. */
function Route({ reverse }: { reverse: boolean }) {
  const from = reverse ? "Canton" : EVM_CHAIN;
  const to = reverse ? EVM_CHAIN : "Canton";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">{from}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" className="text-foreground/35" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">{to}</span>
    </span>
  );
}

export default function OrdersPage() {
  const wallet = useWallet();
  const evm = useEvmWallet();
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [sessionParty, setSessionParty] = useState<string | null>(null);
  const [sessionAuthed, setSessionAuthed] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [identityProbed, setIdentityProbed] = useState(false);

  useEffect(() => { setMounted(true); purgeExpiredSecrets(); }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/parties/me")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setSessionParty(d?.partyId ?? null);
        setSessionAuthed(!!d?.authed);
      })
      .catch(() => {})
      .finally(() => { if (alive) setIdentityProbed(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void createSupabaseBrowserClient()
      .auth.getUser()
      .then(({ data }) => { if (alive) setSessionUserId(data.user?.id ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const vaultContext = useVaultContext({
    loopProvider: wallet.provider,
    evmAddress: evm.account,
    sessionUserId,
    sessionPartyId: sessionParty,
  });

  useEffect(() => {
    if (wallet.isLoading || !identityProbed) return;
    let alive = true;
    void fetchMergedSwapHistory({
      sessionAuthed,
      sessionParty,
      loopParty: wallet.partyId,
    })
      .then((d) => {
        if (!alive) return;
        const nextOrders = (d.orders ?? []) as HistoryOrder[];
        setOrders(nextOrders);
        setOptimisticStatus((prev) => {
          const next = { ...prev };
          for (const order of nextOrders) {
            if (!next[order.id]) continue;
            if (["main_claimed", "both_claimed", "refunded", "cancelled", "failed"].includes(order.status)) {
              delete next[order.id];
            }
          }
          return next;
        });
      })
      .catch((e) => { if (alive) setError(getSwapErrorMessage(e)); });
    return () => { alive = false; };
  }, [wallet.isLoading, wallet.partyId, sessionAuthed, sessionParty, identityProbed, reload]);

  // Close the drawer on Escape.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenId(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  const doRecover = useCallback(async (o: HistoryOrder, action: "retake-wbtc" | "refund-cbtc") => {
    setBusy(o.id); setError(null);
    try {
      if (action === "retake-wbtc") {
        if (!evm.account) throw new Error("Connect your EVM wallet to retake your WBTC.");
        const tx = await evmRetake(evm.sendTransaction, HTLC_ESCROW, o.id);
        await htlcApi.recordRetake(o.id, tx).catch(() => {});
        forgetSecret(o.id);
      } else {
        await htlcApi.refundMain(o.id);
      }
      forgetSecret(o.id);
      setOptimisticStatus((prev) => ({ ...prev, [o.id]: "refunded" }));
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [evm]);

  const doConfirmLock = useCallback(async (o: HistoryOrder) => {
    setBusy(o.id); setError(null);
    try {
      await htlcApi.confirmLockLoop(o.id);
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);

  /** Re-sign the cBTC transfer in Loop when confirm finds no on-ledger offer
   *  (page refresh before submit, or a failed Loop transaction). */
  const doRetryLoopLock = useCallback(async (o: HistoryOrder) => {
    const provider = wallet.provider;
    if (!provider) {
      setError("Connect your Loop wallet to retry the cBTC lock.");
      return;
    }
    setBusy(o.id);
    setError(null);
    try {
      const holdingCids = await listLoopCbtcHoldingCids(
        provider as unknown as { getActiveContracts: (p?: { interfaceId?: string }) => Promise<unknown[]> },
      );
      if (!holdingCids.length) throw new Error("No unlocked cBTC holdings found in your Loop wallet.");
      const prep = await htlcApi.prepareLockLoop(o.id, holdingCids);
      const userParty = (provider as { party_id?: string }).party_id ?? wallet.partyId ?? "";
      await provider.submitAndWaitForTransaction(
        {
          commands: [prep.command],
          disclosedContracts: prep.disclosedContracts,
          packageIdSelectionPreference: [],
          actAs: [userParty],
          readAs: [userParty],
          synchronizerId: prep.synchronizerId,
        },
        undefined,
      );
      await htlcApi.confirmLockLoop(o.id);
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [wallet.provider, wallet.partyId]);

  // CLAIM a claimable swap from the encrypted vault (or manual paste) — same logic
  // the /swap page runs, so a swap can be completed from /orders / after a refresh.
  const doClaim = useCallback(async (o: HistoryOrder, manualSecret?: string) => {
    let secret = manualSecret?.trim() ?? null;
    if (!secret) {
      const ctx = await vaultContext();
      const orderMeta = vaultMetaFromOrder(o) ?? undefined;
      secret = await recallSecret(o.id, { ...ctx, orderMeta });
    }
    if (!secret) {
      setError(
        o.counterMode === "loop"
          ? "Could not unlock this swap's secret. Connect your Loop wallet and approve the unlock sign, or paste your saved secret."
          : "This swap's secret isn't available on this device. Sign in with the same account or paste your saved secret.",
      );
      return;
    }
    setBusy(o.id); setError(null);
    try {
      await claimSwap({
        order: { id: o.id, direction: o.direction, counterMode: o.counterMode },
        secret,
        escrow: HTLC_ESCROW,
        send: evm.sendTransaction,
        loop: wallet.provider as unknown as { party_id?: string; submitAndWaitForTransaction: (p: unknown, o?: unknown) => Promise<unknown> } | null,
      });
      forgetSecret(o.id);
      // User leg stops at counter_claimed (Settling). Completed needs the HTLC daemon.
      setOptimisticStatus((prev) => ({ ...prev, [o.id]: "counter_claimed" }));
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [evm, wallet.provider, vaultContext]);

  const doLoopAccept = useCallback(async (o: HistoryOrder) => {
    const loop = wallet.provider as unknown as {
      party_id?: string;
      submitAndWaitForTransaction: (p: unknown, opts?: unknown) => Promise<unknown>;
    } | null;
    if (!loop) {
      setError("Connect your Loop wallet to accept your cBTC.");
      return;
    }
    setBusy(o.id);
    setError(null);
    try {
      const { command, disclosedContracts, synchronizerId } = await htlcApi.prepareAccept(o.id);
      const userParty = loop.party_id ?? wallet.partyId ?? "";
      await loop.submitAndWaitForTransaction(
        {
          commands: [command],
          disclosedContracts,
          packageIdSelectionPreference: [],
          actAs: [userParty],
          readAs: [userParty],
          synchronizerId,
        },
        undefined,
      );
      setReload((n) => n + 1);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [wallet.provider, wallet.partyId]);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200);
  }, []);

  const explorer = SWAP_CHAIN.blockExplorerUrls?.[0] ?? "";
  const activeBase = openId && orders ? orders.find((x) => x.id === openId) ?? null : null;
  const active = activeBase && optimisticStatus[activeBase.id] ? { ...activeBase, status: optimisticStatus[activeBase.id] } : activeBase;

  return (
    <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:py-10">
      <div className="mb-5 flex items-end justify-between px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Orders</h1>
        {orders && orders.length > 0 && (
          <span className="text-sm text-foreground/50">{orders.length} swap{orders.length === 1 ? "" : "s"}</span>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          ⚠️ {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card shadow-sm">
        {!orders && !error && (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70" />
          </div>
        )}

        {orders && orders.length === 0 && (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground/70">No swaps yet</p>
            <p className="mt-1 text-sm text-foreground/45">Your completed and pending swaps will appear here.</p>
          </div>
        )}

        {orders && orders.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">
                <th className="px-4 py-3 font-medium">Swap</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Route</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Type</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Date</th>
                <th className="px-4 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const displayOrder = optimisticStatus[o.id] ? { ...o, status: optimisticStatus[o.id] } : o;
                const reverse = displayOrder.direction === "canton-to-evm";
                const pay = reverse ? `${fmtCbtc(displayOrder.cbtcAmount)} CBTC` : `${fmtWbtc(displayOrder.wbtcAmount)} WBTC`;
                const recv = reverse ? `${fmtWbtc(displayOrder.wbtcAmount)} WBTC` : `${fmtCbtc(displayOrder.cbtcAmount)} CBTC`;
                const action = recoveryAction(displayOrder);
                const claimable = isClaimableOrder(displayOrder);
                return (
                  <tr
                    key={displayOrder.id}
                    onClick={() => setOpenId(displayOrder.id)}
                    className="cursor-pointer border-b border-foreground/5 transition-colors last:border-0 hover:bg-foreground/[0.025]"
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <span>{pay}</span>
                        <svg width="13" height="13" viewBox="0 0 24 24" className="text-foreground/35" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span>{recv}</span>
                      </div>
                      {/* mobile: route + date inline under the amounts */}
                      <div className="mt-1 flex items-center gap-2 sm:hidden">
                        <Route reverse={reverse} />
                        <span className="text-xs text-foreground/40">· {fmtDateShort(displayOrder.createdAt)}</span>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3.5 sm:table-cell"><Route reverse={reverse} /></td>
                    <td className="hidden px-4 py-3.5 text-xs text-foreground/60 md:table-cell">
                      {displayOrder.counterMode === "loop" ? "Loop wallet" : "Account"}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3.5 text-xs text-foreground/55 md:table-cell">
                      {fmtDateShort(displayOrder.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        {claimable ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); doClaim(o); }}
                            disabled={busy === displayOrder.id}
                            className="rounded-lg bg-[#b04a2a] px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {busy === displayOrder.id ? "Claiming…" : "Claim"}
                          </button>
                        ) : action && (
                          <button
                            onClick={(e) => { e.stopPropagation(); doRecover(displayOrder, action); }}
                            disabled={busy === displayOrder.id}
                            className="rounded-lg border border-foreground/15 px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
                          >
                            {busy === displayOrder.id ? "Submitting…" : action === "retake-wbtc" ? "Retake" : "Refund"}
                          </button>
                        )}
                        <StatusPill status={displayOrder.status} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* DETAIL DRAWER — portal to body so no ancestor containing-block can clip it. */}
      {mounted && active && createPortal(
        <DetailDrawer
          o={active}
          explorer={explorer}
          copied={copied}
          onCopy={copy}
          onClose={() => setOpenId(null)}
          onRecover={doRecover}
          onClaim={doClaim}
          onConfirmLock={doConfirmLock}
          onRetryLoopLock={doRetryLoopLock}
          onLoopAccept={doLoopAccept}
          loopConnected={!!wallet.provider}
          busy={busy === active.id}
        />,
        document.body,
      )}
    </div>
  );
}

function DetailDrawer({
  o, explorer, copied, onCopy, onClose, onRecover, onClaim, onConfirmLock, onRetryLoopLock,
  onLoopAccept, loopConnected, busy,
}: {
  o: HistoryOrder;
  explorer: string;
  copied: string | null;
  onCopy: (s: string) => void;
  onClose: () => void;
  onRecover: (o: HistoryOrder, a: "retake-wbtc" | "refund-cbtc") => void;
  onClaim: (o: HistoryOrder, manualSecret?: string) => void;
  onConfirmLock: (o: HistoryOrder) => void;
  onRetryLoopLock: (o: HistoryOrder) => void;
  onLoopAccept: (o: HistoryOrder) => void;
  loopConnected: boolean;
  busy: boolean;
}) {
  const reverse = o.direction === "canton-to-evm";
  const action = recoveryAction(o);
  const claimable = isClaimableOrder(o);
  const lockConfirm = needsLoopLockConfirm(o);
  const loopAccept = needsLoopAccept(o);
  const awaitingSolver = isAwaitingSolverFinalize(o);
  const vaultReady = hasStoredSecret(o.id);
  const [manualSecret, setManualSecret] = useState("");

  const Row = ({ label, value, mono, copyText, href }: {
    label: string; value: string; mono?: boolean; copyText?: string; href?: string;
  }) => (
    <div className="grid grid-cols-[40%_60%] items-start gap-3 py-2.5">
      <span className="text-xs text-foreground/50">{label}</span>
      <span className={cn("min-w-0 break-words text-right text-xs text-foreground/85", mono && "font-mono")}>
        {href ? (
          <a className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground" target="_blank" rel="noopener noreferrer" href={href}>{value} ↗</a>
        ) : value}
        {copyText && (
          <button onClick={() => onCopy(copyText)} className="ml-1.5 align-middle text-foreground/35 hover:text-foreground" title="Copy">
            {copied === copyText ? "✓" : "⧉"}
          </button>
        )}
      </span>
    </div>
  );

  const txHref = (tx?: string) => (tx && tx.startsWith("0x") && explorer ? `${explorer}/tx/${tx}` : undefined);

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-t-2xl border border-foreground/10 bg-card shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
          <h2 className="text-base font-semibold">Swap details</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-foreground/40 hover:bg-foreground/5 hover:text-foreground" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="px-5 py-4">
          {/* Headline: route + status */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <Route reverse={reverse} />
            <StatusPill status={o.status} />
          </div>

          {/* Amounts */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-foreground/[0.04] px-3 py-2.5">
              <div className="text-xs text-foreground/45">You send</div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">
                {reverse ? `${fmtCbtc(o.cbtcAmount)} CBTC` : `${fmtWbtc(o.wbtcAmount)} WBTC`}
              </div>
              <div className="text-xs text-foreground/45">{reverse ? "Canton" : EVM_CHAIN}</div>
            </div>
            <div className="rounded-xl bg-foreground/[0.04] px-3 py-2.5">
              <div className="text-xs text-foreground/45">You receive</div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">
                {reverse ? `${fmtWbtc(o.wbtcAmount)} WBTC` : `${fmtCbtc(o.cbtcAmount)} CBTC`}
              </div>
              <div className="text-xs text-foreground/45">{reverse ? EVM_CHAIN : "Canton"}</div>
            </div>
          </div>

          <div className="divide-y divide-foreground/5">
            <Row label="Type" value={o.counterMode === "loop" ? "Loop wallet (external)" : "Account (managed)"} />
            <Row label="Order ID" value={shortId(o.id)} mono copyText={o.id} />
            <Row label="Created" value={fmtTime(o.createdAt)} />
            {o.userEvmAddress && <Row label="Your EVM address" value={shortId(o.userEvmAddress)} mono copyText={o.userEvmAddress} />}
            {o.userCantonParty && <Row label="Your Canton party" value={shortId(o.userCantonParty)} mono copyText={o.userCantonParty} />}
            {o.userTimelock ? <Row label={`Your timelock (${reverse ? "Canton" : "EVM"})`} value={fmtTime(o.userTimelock)} /> : null}
            {o.solverTimelock ? <Row label={`Solver timelock (${reverse ? "EVM" : "Canton"})`} value={fmtTime(o.solverTimelock)} /> : null}
            {/* EVM-side lock tx is the explorer-linkable one. */}
            {!reverse && o.mainLockTx && <Row label="WBTC lock (EVM)" value={shortId(o.mainLockTx)} mono href={txHref(o.mainLockTx)} />}
            {reverse && o.counterLockTx && <Row label="WBTC lock (EVM)" value={shortId(o.counterLockTx)} mono href={txHref(o.counterLockTx)} />}
            {o.mainClaimTx && o.mainClaimTx.startsWith("0x") && <Row label="WBTC claim (EVM)" value={shortId(o.mainClaimTx)} mono href={txHref(o.mainClaimTx)} />}
            {o.revealedPreimage ? <Row label="Secret" value="revealed ✓" /> : null}
          </div>

          {claimable ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                {vaultReady
                  ? o.counterMode === "loop"
                    ? "Approve the Loop unlock sign to use the saved secret, or paste it below."
                    : "Sign in with the same account to unlock the saved secret, or paste it below."
                  : o.counterMode === "loop"
                    ? "Connect your Loop wallet to unlock the saved secret, or paste it below."
                    : "Sign in with the same account to unlock the saved secret, or paste it below."}
              </p>
              <input
                type="password"
                autoComplete="off"
                placeholder="Optional: paste saved secret (0x…)"
                value={manualSecret}
                onChange={(e) => setManualSecret(e.target.value)}
                className="w-full rounded-xl border border-foreground/15 bg-transparent px-3 py-2 text-xs font-mono text-foreground"
              />
              <button
                onClick={() => onClaim(o, manualSecret.trim() || undefined)}
                disabled={busy}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Claiming…" : reverse ? "Claim my WBTC" : "Claim my CBTC"}
              </button>
            </div>
          ) : awaitingSolver && !loopAccept ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                Your cBTC is delivered. Waiting for the solver to claim your WBTC on EVM —
                refresh in a few seconds if <span className="font-mono">npm run solver:htlc</span> is
                running (not <span className="font-mono">solver:watch</span>).
              </p>
            </div>
          ) : loopAccept ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                Your secret was revealed but the cBTC transfer still needs a standard accept in Loop
                (no cBTC preapproval on this wallet yet).
              </p>
              <button
                onClick={() => onLoopAccept(o)}
                disabled={busy || !loopConnected}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Waiting for Loop…" : loopConnected ? "Accept cBTC in Loop" : "Connect Loop to accept cBTC"}
              </button>
            </div>
          ) : lockConfirm ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                This swap is waiting for your cBTC lock. If you already signed in Loop, confirm here
                (may take up to ~30s while the offer syncs). If the page refreshed before you signed,
                connect Loop and retry the lock.
              </p>
              <button
                onClick={() => onConfirmLock(o)}
                disabled={busy}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Confirming…" : "Confirm cBTC lock"}
              </button>
              <button
                onClick={() => onRetryLoopLock(o)}
                disabled={busy || !loopConnected}
                className="w-full rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-semibold text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
              >
                {busy ? "Waiting for Loop…" : loopConnected ? "Retry lock in Loop" : "Connect Loop to retry lock"}
              </button>
            </div>
          ) : action ? (
            <button
              onClick={() => onRecover(o, action)}
              disabled={busy}
              className="mt-4 w-full rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-semibold text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
            >
              {busy ? "Submitting…" : action === "retake-wbtc" ? "Retake my WBTC" : "Refund my cBTC"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
