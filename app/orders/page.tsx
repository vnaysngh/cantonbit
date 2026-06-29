"use client";

/**
 * /orders — swap history for the logged-in user (both directions).
 * Identity: email session (server resolves the warpx party from the cookie) or
 * the connected Loop wallet (party passed as a query param). Newest first.
 *
 * Production table view + a portal-rendered detail drawer (portal escapes any
 * ancestor containing-block so the drawer is never clipped/collapsed).
 */
import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";

import { useWallet } from "@/hooks/useWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useVaultContext } from "@/hooks/useVaultContext";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  claimSwap,
  evmRetake,
  fetchMergedSwapHistory,
  htlcApi
} from "@/lib/htlc-client";
import { cantonSwapApi } from "@/lib/canton-swap-client";
import type { CantonSwapOrder } from "@/lib/canton-swap-types";
import {
  cantonSwapPayReceive,
  isCantonSwapHistoryRow,
  mapCantonSwapToHistoryRow,
  needsCantonSwapCounterAccept,
  type CantonSwapHistoryRow
} from "@/lib/canton-swap-history";
import {
  isSmokeTestOrderId,
  isSwapClaimable,
  ORDERS_HISTORY_PAGE_SIZE,
  ORDERS_LIVE_POLL_MAX,
  ORDERS_LIVE_POLL_MS,
  htlcUserWbtcClaimTx
} from "@/lib/htlc-order-logic";
import { truncatePartyId } from "@/lib/party-display";
import type { SwapStatus } from "@/lib/htlc-types";
import {
  forgetSecret,
  hasStoredSecret,
  purgeExpiredSecrets,
  vaultMetaFromOrder
} from "@/lib/secret-vault";
import {
  ensureHtlcSecretVaulted,
  resolveHtlcClaimSecret
} from "@/lib/htlc-secret-resolver";
import {
  canReconnectReverseLoopCommit,
  clearPendingLoopCommit,
  hasPendingLoopIntent,
  readPendingLoopCommitByKey,
  recallPendingHtlcSecret
} from "@/lib/swap-pending-loop-commit";
import { listLoopCbtcHoldingCids } from "@/lib/loop-holdings";
import { getSwapErrorMessage } from "@/lib/swap-api";
import { chainConfigForOrder, type SwapChain } from "@/lib/swap-evm";
import { cn } from "@/lib/utils";
import {
  projectC2cStatus,
  projectHtlcStatus,
  projectedToneClass,
  type ProjectedSwapStatus
} from "@/lib/swap-status-projector";

const SOLVER_EVM =
  process.env.NEXT_PUBLIC_SOLVER_EVM ??
  "0x0B95ec21579aee6Ef7b712976bD86689D68b5A08";
const SOLVER_CANTON =
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY ?? "";

interface HistoryOrder {
  id: string;
  direction: "evm-to-canton" | "canton-to-evm" | "canton-swap";
  status: string;
  wbtcAmount: string; // 8dp base units
  cbtcAmount: string; // decimal string
  userEvmAddress?: string;
  userCantonParty?: string;
  solverCantonParty?: string;
  mainLockTx?: string;
  counterLockTx?: string;
  counterTransferUpdateId?: string;
  counterTransferOfferCid?: string;
  mainClaimTx?: string;
  counterClaimUpdateId?: string;
  settlementUpdateId?: string;
  counterReceiptUpdateId?: string;
  allocationCid?: string;
  htlcCid?: string;
  createdAt: number; // unix seconds
  counterMode?: string;
  userTimelock?: number;
  solverTimelock?: number;
  revealedPreimage?: string;
  mainLeg?: { asset: string; amount: string };
  counterLeg?: { asset: string; amount: string };
  failureReason?: string;
  walletMode?: string;
  networkFeeCollected?: boolean;
  evmChainSlug?: string;
  evmChainId?: number;
  evmEscrowAddress?: string;
  evmWbtcAddress?: string;
}

function evmChainForOrder(order: Pick<HistoryOrder, "evmChainSlug" | "evmChainId" | "evmEscrowAddress" | "evmWbtcAddress">): SwapChain {
  return chainConfigForOrder(order);
}

function htlcEscrowForOrder(order: Pick<HistoryOrder, "evmChainSlug" | "evmChainId" | "evmEscrowAddress" | "evmWbtcAddress">): string {
  const chain = evmChainForOrder(order);
  const escrow = chain.escrow?.trim();
  if (!escrow) throw new Error(`HTLC escrow is not configured for ${chain.name}.`);
  return escrow;
}

function isCantonSwapOrder(
  o: HistoryOrder
): o is HistoryOrder & CantonSwapHistoryRow {
  return isCantonSwapHistoryRow(o);
}

function orderPayReceive(o: HistoryOrder): { pay: string; receive: string } {
  if (isCantonSwapOrder(o)) return cantonSwapPayReceive(o);
  const reverse = o.direction === "canton-to-evm";
  return {
    pay: reverse
      ? `${fmtCbtc(o.cbtcAmount)} CBTC`
      : `${fmtWbtc(o.wbtcAmount)} WBTC`,
    receive: reverse
      ? `${fmtWbtc(o.wbtcAmount)} WBTC`
      : `${fmtCbtc(o.cbtcAmount)} CBTC`
  };
}

/** True if the user actually has funds locked that a refund/retake would return. */
function hasLockedFunds(o: HistoryOrder): boolean {
  if (isCantonSwapOrder(o)) return o.status === "user_locked";
  if (o.direction === "evm-to-canton") return !!o.mainLockTx; // user's WBTC on EVM
  return !!o.htlcCid || !!o.counterTransferUpdateId || !!o.allocationCid; // user's CBTC on Canton
}

function isClaimableOrder(o: HistoryOrder): boolean {
  if (isCantonSwapOrder(o)) return false;
  return isSwapClaimable({
    status: o.status as SwapStatus,
    direction: o.direction as "evm-to-canton" | "canton-to-evm",
    counterMode:
      o.counterMode === "loop" || o.counterMode === "managed"
        ? o.counterMode
        : undefined,
    revealedPreimage: o.revealedPreimage as `0x${string}` | undefined
  });
}

/** Loop reverse: user signed the CBTC lock in Loop but confirm-lock-loop never ran (e.g. refresh). */
function needsLoopLockConfirm(o: HistoryOrder): boolean {
  return (
    o.direction === "canton-to-evm" &&
    o.counterMode === "loop" &&
    (o.status === "accepted" || o.status === "main_locking") &&
    !o.counterTransferUpdateId &&
    !o.counterTransferOfferCid
  );
}

/** Loop forward: secret revealed and CBTC offer sent, but user still owes a standard accept. */
function needsLoopAccept(o: HistoryOrder): boolean {
  return (
    o.direction === "evm-to-canton" &&
    o.counterMode === "loop" &&
    o.status === "counter_claimed" &&
    !!o.counterTransferOfferCid &&
    !o.counterClaimUpdateId
  );
}

/** User leg done; waiting for the HTLC solver daemon to claim WBTC on EVM. */
function isAwaitingSolverFinalize(o: HistoryOrder): boolean {
  if (o.direction !== "evm-to-canton" || o.status !== "counter_claimed") {
    return false;
  }
  if (
    o.counterMode === "loop" &&
    !!o.counterTransferOfferCid &&
    !o.counterClaimUpdateId
  ) {
    return false;
  }
  return true;
}

/** What recovery action (if any) the user can take on a stuck order, NOW. Only
 *  shown when funds are ACTUALLY locked, the secret isn't revealed, and the user
 *  timelock has passed. (An 'accepted' order that never locked has nothing to refund.) */
function recoveryAction(o: HistoryOrder): "retake-wbtc" | "refund-cbtc" | null {
  const now = Math.floor(Date.now() / 1000);
  const live = o.status === "main_locked" || o.status === "counter_locked";
  if (!live || o.revealedPreimage || !hasLockedFunds(o)) return null;
  if (!o.userTimelock || now < o.userTimelock) return null;
  if (isCantonSwapOrder(o)) return null;
  return o.direction === "evm-to-canton" ? "retake-wbtc" : "refund-cbtc";
}

function fmtWbtc(units: string): string {
  try {
    return (Number(BigInt(units)) / 1e8)
      .toFixed(8)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  } catch {
    return units;
  }
}
function fmtCbtc(dec: string): string {
  const n = parseFloat(dec);
  return Number.isFinite(n)
    ? n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
    : dec;
}
function shortId(s?: string): string {
  return s ? truncatePartyId(s) : "—";
}
function fmtTime(unix?: number): string {
  return unix ? new Date(unix * 1000).toLocaleString() : "—";
}
function fmtDateShort(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function projectHistoryStatus(o: HistoryOrder): ProjectedSwapStatus {
  if (isCantonSwapOrder(o)) {
    return projectC2cStatus({
      status: o.status as never,
      settlementUpdateId: o.settlementUpdateId,
      counterLegOfferCid: o.counterTransferOfferCid,
      counterReceiptUpdateId: o.counterReceiptUpdateId
    });
  }
  return projectHtlcStatus({
    status: o.status as SwapStatus,
    direction: o.direction as "evm-to-canton" | "canton-to-evm",
    counterMode:
      o.counterMode === "loop" || o.counterMode === "managed"
        ? o.counterMode
        : undefined,
    revealedPreimage: o.revealedPreimage as `0x${string}` | undefined,
    counterTransferUpdateId: o.counterTransferUpdateId,
    counterTransferOfferCid: o.counterTransferOfferCid,
    counterClaimUpdateId: o.counterClaimUpdateId,
    mainClaimTx: o.mainClaimTx
  });
}

function StatusPill({ order }: { order: HistoryOrder }) {
  const status = projectHistoryStatus(order);
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        projectedToneClass(status.tone)
      )}
    >
      {status.label}
    </span>
  );
}

/** A small chain→chain pill pair. */
function Route({ order }: { order: HistoryOrder }) {
  if (isCantonSwapOrder(order)) {
    const pay = order.mainLeg?.asset ?? "Canton";
    const recv = order.counterLeg?.asset ?? "Canton";
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
        <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">
          {pay}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          className="text-foreground/35"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            d="M5 12h14M13 6l6 6-6 6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">
          {recv}
        </span>
        <span className="text-foreground/40">· Canton</span>
      </span>
    );
  }
  const reverse = order.direction === "canton-to-evm";
  const evmChain = evmChainForOrder(order).name;
  const from = reverse ? "Canton" : evmChain;
  const to = reverse ? evmChain : "Canton";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">
        {from}
      </span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        className="text-foreground/35"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path
          d="M5 12h14M13 6l6 6-6 6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/75">
        {to}
      </span>
    </span>
  );
}

export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
          Loading orders…
        </div>
      }
    >
      <OrdersPageInner />
    </Suspense>
  );
}

function OrdersPageInner() {
  const wallet = useWallet();
  const evm = useEvmWallet();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [optimisticStatus, setOptimisticStatus] = useState<
    Record<string, string>
  >({});
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deepLinkOrder, setDeepLinkOrder] = useState<HistoryOrder | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [sessionParty, setSessionParty] = useState<string | null>(null);
  const [sessionAuthed, setSessionAuthed] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [identityProbed, setIdentityProbed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setMounted(true);
    purgeExpiredSecrets();
  }, []);

  useEffect(() => {
    const id = searchParams.get("id")?.trim();
    if (!id) {
      setDeepLinkOrder(null);
      return;
    }
    setOpenId(id);
  }, [searchParams]);

  // Deep-link ?id=… — fetch the order even if history filter hid it.
  useEffect(() => {
    const id = searchParams.get("id")?.trim();
    if (!id || orders?.some((o) => o.id === id)) {
      if (id && orders?.some((o) => o.id === id)) setDeepLinkOrder(null);
      return;
    }
    let alive = true;
    const kind = searchParams.get("kind");
    const fetchOrder =
      kind === "canton-swap"
        ? cantonSwapApi
            .get(id)
            .then(({ order }) => mapCantonSwapToHistoryRow(order))
        : htlcApi
            .getOrder(id, { light: true })
            .then(({ order }) => order as HistoryOrder);
    void fetchOrder
      .then((row) => {
        if (!alive || !row) return;
        setDeepLinkOrder(row);
        setOrders((prev) => {
          const list = prev ?? [];
          if (list.some((o) => o.id === id)) return list;
          return [row, ...list].sort((a, b) => b.createdAt - a.createdAt);
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [searchParams, orders]);

  const liveOrders = useMemo(() => {
    if (!orders) return [];
    return orders
      .map((o) => ({
        ...o,
        status: optimisticStatus[o.id] ?? o.status
      }))
      .filter((o) => {
        if (projectHistoryStatus(o).terminal) return false;
        if (isCantonSwapOrder(o)) {
          return ["open", "user_locked", "filling", "settling", "filled"].includes(
            o.status
          );
        }
        // Keep polling until proof-aware projection says the swap is complete —
        // raw main_claimed is not enough (missing mainClaimTx / Loop accept proof).
        return !projectHistoryStatus(o).proofComplete;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, ORDERS_LIVE_POLL_MAX);
  }, [orders, optimisticStatus]);

  useEffect(() => {
    if (liveOrders.length === 0) return;
    let alive = true;
    const poll = async () => {
      const updates = await Promise.allSettled(
        liveOrders.map(async (row) => {
          if (isCantonSwapOrder(row)) {
            const { order } = await cantonSwapApi.get(row.id);
            return mapCantonSwapToHistoryRow(order);
          }
          const { order } = await htlcApi.getOrder(row.id, { light: true });
          return order as HistoryOrder;
        })
      );
      if (!alive) return;
      setOrders((prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.map((o) => [o.id, o]));
        for (const result of updates) {
          if (result.status !== "fulfilled" || !result.value?.id) continue;
          const existing = byId.get(result.value.id);
          byId.set(
            result.value.id,
            existing ? { ...existing, ...result.value } : result.value
          );
        }
        return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      });
    };
    void poll();
    const id = setInterval(poll, ORDERS_LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveOrders.map((o) => `${o.id}:${o.status}`).join("|")]);

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
      .finally(() => {
        if (alive) setIdentityProbed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void createSupabaseBrowserClient()
      .auth.getUser()
      .then(({ data }) => {
        if (alive) setSessionUserId(data.user?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const vaultContext = useVaultContext({
    loopProvider: wallet.provider,
    evmAddress: evm.account,
    sessionUserId,
    sessionPartyId: sessionParty
  });

  const mergeHistoryPage = useCallback(
    async (beforeCreatedAt?: number) => {
      const pageOpts = {
        sessionAuthed,
        sessionParty,
        loopParty: wallet.partyId,
        userEvmAddress: sessionAuthed ? evm.account : null,
        limit: ORDERS_HISTORY_PAGE_SIZE,
        beforeCreatedAt
      };
      const party = sessionParty ?? wallet.partyId;
      const [htlcPage, c2cPage] = await Promise.all([
        fetchMergedSwapHistory(pageOpts),
        party
          ? cantonSwapApi
              .history(party, {
                limit: ORDERS_HISTORY_PAGE_SIZE,
                beforeCreatedAt
              })
              .catch(() => ({ orders: [] as CantonSwapOrder[], hasMore: false }))
          : Promise.resolve({ orders: [] as CantonSwapOrder[], hasMore: false })
      ]);
      const htlcOrders = (htlcPage.orders ?? []).filter(
        (o) => !isSmokeTestOrderId((o as HistoryOrder).id)
      ) as HistoryOrder[];
      const cantonRows = (c2cPage.orders ?? [])
        .filter((o) => !isSmokeTestOrderId(o.id))
        .map((o) => mapCantonSwapToHistoryRow(o));
      const merged = [...htlcOrders, ...cantonRows].sort(
        (a, b) => b.createdAt - a.createdAt
      );
      return { merged, hasMore: htlcPage.hasMore || c2cPage.hasMore };
    },
    [sessionAuthed, sessionParty, wallet.partyId, evm.account]
  );

  useEffect(() => {
    if (wallet.isLoading || !identityProbed) return;
    let alive = true;
    setHasMore(false);
    void mergeHistoryPage()
      .then(({ merged, hasMore: more }) => {
        if (!alive) return;
        setOrders(merged);
        setHasMore(more);
        setOptimisticStatus((prev) => {
          const next = { ...prev };
          for (const order of merged) {
            if (!next[order.id]) continue;
            if (
              [
                "main_claimed",
                "both_claimed",
                "refunded",
                "cancelled",
                "failed",
                "filled",
                "expired"
              ].includes(order.status)
            ) {
              delete next[order.id];
            }
          }
          return next;
        });
      })
      .catch((e) => {
        if (alive) setError(getSwapErrorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [
    wallet.isLoading,
    wallet.partyId,
    sessionAuthed,
    sessionParty,
    evm.account,
    identityProbed,
    reload,
    mergeHistoryPage
  ]);

  const loadMoreOrders = useCallback(async () => {
    if (!orders?.length || loadingMore || !hasMore) return;
    const beforeCreatedAt = orders[orders.length - 1]!.createdAt;
    setLoadingMore(true);
    try {
      const { merged, hasMore: more } = await mergeHistoryPage(beforeCreatedAt);
      setOrders((prev) => {
        const byId = new Map((prev ?? []).map((o) => [o.id, o]));
        for (const o of merged) byId.set(o.id, o);
        return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      });
      setHasMore(more);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [orders, loadingMore, hasMore, mergeHistoryPage]);

  // Close the drawer on Escape.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  const doRecover = useCallback(
    async (o: HistoryOrder, action: "retake-wbtc" | "refund-cbtc") => {
      setBusy(o.id);
      setError(null);
      try {
        if (action === "retake-wbtc") {
          if (!evm.account)
            throw new Error("Connect your EVM wallet to retake your WBTC.");
          const tx = await evmRetake(
            evm.sendTransaction,
            htlcEscrowForOrder(o),
            o.id
          );
          await evm.waitForReceipt(tx);
          await htlcApi.recordRetake(o.id, tx);
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
    },
    [evm]
  );

  const persistPendingHtlcSecret = useCallback(
    async (o: HistoryOrder) => {
      const pendingSecret = recallPendingHtlcSecret(o.id);
      if (!pendingSecret) return;
      const orderMeta = vaultMetaFromOrder({
        direction: o.direction as "evm-to-canton" | "canton-to-evm",
        counterMode: o.counterMode,
        userCantonParty: o.userCantonParty,
        userEvmAddress: o.userEvmAddress,
        userTimelock: o.userTimelock,
        solverTimelock: o.solverTimelock
      });
      if (!orderMeta) return;
      await ensureHtlcSecretVaulted(
        o.id,
        pendingSecret,
        {
          direction: orderMeta.direction,
          counterMode: orderMeta.counterMode,
          userCantonParty: orderMeta.userCantonParty,
          userEvmAddress: orderMeta.userEvmAddress,
          userTimelock: o.userTimelock!,
          solverTimelock: o.solverTimelock
        },
        await vaultContext()
      );
    },
    [vaultContext]
  );

  const doConfirmLock = useCallback(async (o: HistoryOrder) => {
    setBusy(o.id);
    setError(null);
    try {
      await htlcApi.confirmLockLoop(o.id);
      await persistPendingHtlcSecret(o);
      clearPendingLoopCommit(o.id);
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [persistPendingHtlcSecret]);

  const doReconnectLoopCommit = useCallback(async (o: HistoryOrder) => {
    const pending = readPendingLoopCommitByKey(o.id);
    if (
      !pending ||
      pending.flow !== "reverse-htlc" ||
      !pending.submitUpdateId ||
      !pending.createdAt
    ) {
      setError(
        "No signed Loop transaction was found for this swap on this device."
      );
      return;
    }
    if (!o.userEvmAddress || !o.userCantonParty || !o.userTimelock || !o.solverTimelock) {
      setError("This swap is missing order details — refresh and try again.");
      return;
    }
    setBusy(o.id);
    setError(null);
    try {
      await htlcApi.commitReverseLoop({
        id: o.id,
        direction: "canton-to-evm",
        hashLock: o.id,
        userEvmAddress: o.userEvmAddress,
        solverEvmAddress: SOLVER_EVM,
        wbtcAmount: o.wbtcAmount,
        userTimelock: o.userTimelock,
        userCantonParty: o.userCantonParty,
        solverCantonParty: o.solverCantonParty ?? SOLVER_CANTON,
        cbtcAmount: o.cbtcAmount,
        solverTimelock: o.solverTimelock,
        counterMode: "loop",
        evmChain: o.evmChainSlug,
        createdAt: pending.createdAt,
        submitUpdateId: pending.submitUpdateId,
        offerCidHint: pending.offerCidHint
      });
      clearPendingLoopCommit(o.id);
      setReload((n) => n + 1);
      setOpenId(null);
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);

  /** Re-sign the CBTC transfer in Loop when confirm finds no on-ledger offer
   *  (page refresh before submit, or a failed Loop transaction). */
  const doRetryLoopLock = useCallback(
    async (o: HistoryOrder) => {
      const provider = wallet.provider;
      if (!provider) {
        setError("Connect your Loop wallet to retry the CBTC lock.");
        return;
      }
      setBusy(o.id);
      setError(null);
      try {
        const holdingCids = await listLoopCbtcHoldingCids(
          provider as unknown as {
            getActiveContracts: (p?: {
              interfaceId?: string;
            }) => Promise<unknown[]>;
          }
        );
        if (!holdingCids.length)
          throw new Error(
            "No unlocked CBTC holdings found in your Loop wallet."
          );
        const prep = await htlcApi.prepareLockLoop(o.id, holdingCids);
        const userParty =
          (provider as { party_id?: string }).party_id ?? wallet.partyId ?? "";
        await provider.submitAndWaitForTransaction(
          {
            commands: [prep.command],
            disclosedContracts: prep.disclosedContracts,
            packageIdSelectionPreference: [],
            actAs: [userParty],
            readAs: [userParty],
            synchronizerId: prep.synchronizerId
          },
          undefined
        );
        await htlcApi.confirmLockLoop(o.id);
        await persistPendingHtlcSecret(o);
        setReload((n) => n + 1);
        setOpenId(null);
      } catch (e) {
        setError(getSwapErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet.provider, wallet.partyId, persistPendingHtlcSecret]
  );

  // CLAIM a claimable swap from the encrypted vault (or manual paste) — same logic
  // the /swap page runs, so a swap can be completed from /orders / after a refresh.
  const resolveClaimSecret = useCallback(
    async (o: HistoryOrder, manualSecret?: string): Promise<string | null> => {
      const orderMeta =
        vaultMetaFromOrder({
          direction: o.direction as "evm-to-canton" | "canton-to-evm",
          counterMode: o.counterMode,
          userCantonParty: o.userCantonParty,
          userEvmAddress: o.userEvmAddress,
          userTimelock: o.userTimelock,
          solverTimelock: o.solverTimelock
        }) ?? undefined;
      return resolveHtlcClaimSecret(o.id, o.id, {
        manualSecret,
        ctx: await vaultContext(),
        orderMeta
      });
    },
    [vaultContext]
  );

  const doClaim = useCallback(
    async (o: HistoryOrder, manualSecret?: string) => {
      if (isCantonSwapOrder(o)) {
        setError("Canton swaps settle automatically — no claim step.");
        return;
      }
      const secret = await resolveClaimSecret(o, manualSecret);
      if (!secret) {
        setError(
          hasStoredSecret(o.id)
            ? o.counterMode === "loop"
              ? "Could not unlock this swap's secret. Connect your Loop wallet and approve the unlock sign, or paste your saved secret below."
              : "Could not unlock this swap's secret. Sign in with the same account or paste your saved secret below."
            : hasPendingLoopIntent(o.id)
              ? "This swap has an unfinished sign step on this device. Use Reconnect below, or paste your saved secret."
              : o.counterMode === "loop"
                ? "This swap's secret was not saved on this device — paste the secret from when you started the swap (open the row for the field below)."
                : "This swap's secret isn't available on this device. Sign in with the same account or paste your saved secret."
        );
        return;
      }
      setBusy(o.id);
      setError(null);
      try {
        await claimSwap({
          order: {
            id: o.id,
            direction: o.direction,
            counterMode: o.counterMode
          },
          secret,
          escrow: htlcEscrowForOrder(o),
          send: evm.sendTransaction,
          loop: wallet.provider as unknown as {
            party_id?: string;
            submitAndWaitForTransaction: (
              p: unknown,
              o?: unknown
            ) => Promise<unknown>;
          } | null
        });
        forgetSecret(o.id);
        clearPendingLoopCommit(o.id);
        setOptimisticStatus((prev) => ({ ...prev, [o.id]: "counter_claimed" }));
        setReload((n) => n + 1);
        setOpenId(null);
      } catch (e) {
        setError(getSwapErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [evm, wallet.provider, resolveClaimSecret]
  );

  const doCantonCounterAccept = useCallback(
    async (o: HistoryOrder) => {
      if (!isCantonSwapOrder(o) || !needsCantonSwapCounterAccept(o)) return;
      const loop = wallet.provider;
      if (!loop) {
        setError("Connect Loop wallet to accept incoming tokens.");
        return;
      }
      setBusy(o.id);
      setError(null);
      try {
        const prep = await cantonSwapApi.prepareCounterAccept(o.id);
        const userParty = o.userCantonParty ?? wallet.partyId ?? "";
        await loop.submitAndWaitForTransaction({
          commands: [prep.command],
          disclosedContracts: prep.disclosedContracts,
          packageIdSelectionPreference: [],
          actAs: [userParty],
          readAs: [userParty],
          synchronizerId: prep.synchronizerId
        });
        await cantonSwapApi.confirmCounterAccept(o.id);
        setOptimisticStatus((prev) => ({ ...prev, [o.id]: "filled" }));
        setReload((n) => n + 1);
      } catch (e) {
        setError(getSwapErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet.provider, wallet.partyId]
  );

  const doLoopAccept = useCallback(
    async (o: HistoryOrder) => {
      const loop = wallet.provider as unknown as {
        party_id?: string;
        submitAndWaitForTransaction: (
          p: unknown,
          opts?: unknown
        ) => Promise<unknown>;
      } | null;
      if (!loop) {
        setError("Connect your Loop wallet to accept your CBTC.");
        return;
      }
      setBusy(o.id);
      setError(null);
      try {
        const { command, disclosedContracts, synchronizerId } =
          await htlcApi.prepareAccept(o.id);
        const userParty = loop.party_id ?? wallet.partyId ?? "";
        await loop.submitAndWaitForTransaction(
          {
            commands: [command],
            disclosedContracts,
            packageIdSelectionPreference: [],
            actAs: [userParty],
            readAs: [userParty],
            synchronizerId
          },
          undefined
        );
        setReload((n) => n + 1);
      } catch (e) {
        setError(getSwapErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet.provider, wallet.partyId]
  );

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200);
  }, []);

  const activeBase = useMemo(() => {
    if (!openId) return null;
    const fromList = orders?.find((x) => x.id === openId);
    if (fromList) return fromList;
    if (deepLinkOrder?.id === openId) return deepLinkOrder;
    return null;
  }, [openId, orders, deepLinkOrder]);
  const active =
    activeBase && optimisticStatus[activeBase.id]
      ? { ...activeBase, status: optimisticStatus[activeBase.id] }
      : activeBase;
  const activeExplorer =
    active && !isCantonSwapOrder(active)
      ? (evmChainForOrder(active).blockExplorerUrls?.[0] ?? "")
      : "";

  return (
    <div className="mx-auto w-full max-w-[920px] px-4 py-6 sm:py-10">
      <div className="mb-5 flex items-end justify-between px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Orders
        </h1>
        {orders && orders.length > 0 && (
          <span className="text-sm text-foreground/50">
            {orders.length} loaded
            {hasMore ? "+" : ""}
          </span>
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
            <p className="text-sm font-medium text-foreground/70">
              No swaps yet
            </p>
            <p className="mt-1 text-sm text-foreground/45">
              Your completed and pending swaps will appear here.
            </p>
          </div>
        )}

        {orders && orders.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">
                <th className="px-4 py-3 font-medium">Swap</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">
                  Route
                </th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">
                  Type
                </th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">
                  Date
                </th>
                <th className="px-4 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const displayOrder = optimisticStatus[o.id]
                  ? { ...o, status: optimisticStatus[o.id] }
                  : o;
                const { pay, receive } = orderPayReceive(displayOrder);
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
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          className="text-foreground/35"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path
                            d="M5 12h14M13 6l6 6-6 6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{receive}</span>
                      </div>
                      {/* mobile: route + date inline under the amounts */}
                      <div className="mt-1 flex items-center gap-2 sm:hidden">
                        <Route order={displayOrder} />
                        <span className="text-xs text-foreground/40">
                          · {fmtDateShort(displayOrder.createdAt)}
                        </span>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3.5 sm:table-cell">
                      <Route order={displayOrder} />
                    </td>
                    <td className="hidden px-4 py-3.5 text-xs text-foreground/60 md:table-cell">
                      {displayOrder.counterMode === "loop"
                        ? "Loop wallet"
                        : "Account"}
                      {/* M-05: surface whether the Canton network fee was collected */}
                      {displayOrder.networkFeeCollected === true && (
                        <span className="mt-0.5 block text-[11px] text-foreground/40">
                          Network fee paid
                        </span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3.5 text-xs text-foreground/55 md:table-cell">
                      {fmtDateShort(displayOrder.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        {claimable ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              doClaim(o);
                            }}
                            disabled={busy === displayOrder.id}
                            className="rounded-lg bg-[#b04a2a] px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {busy === displayOrder.id ? "Claiming…" : "Claim"}
                          </button>
                        ) : (
                          action && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                doRecover(displayOrder, action);
                              }}
                              disabled={busy === displayOrder.id}
                              className="rounded-lg border border-foreground/15 px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
                            >
                              {busy === displayOrder.id
                                ? "Submitting…"
                                : action === "retake-wbtc"
                                  ? "Retake"
                                  : "Refund"}
                            </button>
                          )
                        )}
                        <StatusPill order={displayOrder} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {orders && orders.length > 0 && hasMore && (
          <div className="border-t border-foreground/10 px-4 py-4 text-center">
            <button
              type="button"
              onClick={() => void loadMoreOrders()}
              disabled={loadingMore}
              className="rounded-xl border border-foreground/15 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {/* DETAIL DRAWER — portal to body so no ancestor containing-block can clip it. */}
      {mounted &&
        active &&
        createPortal(
          <DetailDrawer
            o={active}
            explorer={activeExplorer}
            copied={copied}
            onCopy={copy}
            onClose={() => setOpenId(null)}
            onRecover={doRecover}
            onClaim={doClaim}
            onConfirmLock={doConfirmLock}
            onRetryLoopLock={doRetryLoopLock}
            onReconnectLoopCommit={doReconnectLoopCommit}
            onLoopAccept={doLoopAccept}
            onCantonCounterAccept={doCantonCounterAccept}
            loopConnected={!!wallet.provider}
            busy={busy === active.id}
          />,
          document.body
        )}
    </div>
  );
}

function DetailDrawer({
  o,
  explorer,
  copied,
  onCopy,
  onClose,
  onRecover,
  onClaim,
  onConfirmLock,
  onRetryLoopLock,
  onReconnectLoopCommit,
  onLoopAccept,
  onCantonCounterAccept,
  loopConnected,
  busy
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
  onReconnectLoopCommit: (o: HistoryOrder) => void;
  onLoopAccept: (o: HistoryOrder) => void;
  onCantonCounterAccept: (o: HistoryOrder) => void;
  loopConnected: boolean;
  busy: boolean;
}) {
  const cantonSwap = isCantonSwapOrder(o);
  const reverse = !cantonSwap && o.direction === "canton-to-evm";
  const evmChainName = cantonSwap ? "EVM" : evmChainForOrder(o).name;
  const action = recoveryAction(o);
  const claimable = isClaimableOrder(o);
  const lockConfirm = !cantonSwap && needsLoopLockConfirm(o);
  const loopCommitReconnect =
    !cantonSwap && canReconnectReverseLoopCommit(o.id, o);
  const loopAccept = !cantonSwap && needsLoopAccept(o);
  const awaitingSolver = !cantonSwap && isAwaitingSolverFinalize(o);
  const cantonCounterAccept = cantonSwap && needsCantonSwapCounterAccept(o);
  const vaultReady = hasStoredSecret(o.id) || hasPendingLoopIntent(o.id);
  const [manualSecret, setManualSecret] = useState("");
  const cantonAmounts = cantonSwap ? cantonSwapPayReceive(o) : null;

  const Row = ({
    label,
    value,
    mono,
    copyText,
    href
  }: {
    label: string;
    value: string;
    mono?: boolean;
    copyText?: string;
    href?: string;
  }) => (
    <div className="grid grid-cols-[40%_60%] items-start gap-3 py-2.5">
      <span className="text-xs text-foreground/50">{label}</span>
      <span
        className={cn(
          "min-w-0 break-words text-right text-xs text-foreground/85",
          mono && "font-mono"
        )}
      >
        {href ? (
          <a
            className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            target="_blank"
            rel="noopener noreferrer"
            href={href}
          >
            {value} ↗
          </a>
        ) : (
          value
        )}
        {copyText && (
          <button
            onClick={() => onCopy(copyText)}
            className="ml-1.5 align-middle text-foreground/35 hover:text-foreground"
            title="Copy"
          >
            {copied === copyText ? "✓" : "⧉"}
          </button>
        )}
      </span>
    </div>
  );

  const txHref = (tx?: string) =>
    tx && tx.startsWith("0x") && explorer ? `${explorer}/tx/${tx}` : undefined;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-t-2xl border border-foreground/10 bg-card shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
          <h2 className="text-base font-semibold">Swap details</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-foreground/40 hover:bg-foreground/5 hover:text-foreground"
            aria-label="Close"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          {/* Headline: route + status */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <Route order={o} />
            <StatusPill order={o} />
          </div>

          {cantonSwap && !projectHistoryStatus(o).terminal && (
            <div className="mb-4 rounded-xl bg-foreground/[0.04] px-4 py-3 text-xs text-foreground/60">
              {o.status === "user_locked" &&
                "Your sell offer is locked — the solver is settling both legs."}
              {o.status === "open" && "Swap order created."}
              {o.status === "settling" && "Settling on Canton…"}
              {o.failureReason ? (
                <p className="mt-2 text-amber-700">{o.failureReason}</p>
              ) : null}
            </div>
          )}

          {cantonSwap && o.status === "failed" && o.failureReason ? (
            <div className="mb-4 rounded-xl bg-red-500/8 px-4 py-3 text-xs text-red-700">
              {o.failureReason.includes("submission in flight")
                ? "The swap may still have settled on Canton — refresh this page to sync status."
                : o.failureReason}
            </div>
          ) : null}

          {/* Amounts */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-foreground/[0.04] px-3 py-2.5">
              <div className="text-xs text-foreground/45">You send</div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">
                {cantonSwap && cantonAmounts?.pay
                  ? cantonAmounts.pay
                  : reverse
                    ? `${fmtCbtc(o.cbtcAmount)} CBTC`
                    : `${fmtWbtc(o.wbtcAmount)} WBTC`}
              </div>
              <div className="text-xs text-foreground/45">
                {cantonSwap ? "Canton" : reverse ? "Canton" : evmChainName}
              </div>
            </div>
            <div className="rounded-xl bg-foreground/[0.04] px-3 py-2.5">
              <div className="text-xs text-foreground/45">You receive</div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">
                {cantonSwap && cantonAmounts?.receive
                  ? cantonAmounts.receive
                  : reverse
                    ? `${fmtWbtc(o.wbtcAmount)} WBTC`
                    : `${fmtCbtc(o.cbtcAmount)} CBTC`}
              </div>
              <div className="text-xs text-foreground/45">
                {cantonSwap ? "Canton" : reverse ? evmChainName : "Canton"}
              </div>
            </div>
          </div>

          <div className="divide-y divide-foreground/5">
            <Row
              label="Type"
              value={
                cantonSwap
                  ? "Canton ↔ Canton"
                  : o.counterMode === "loop"
                    ? "Loop wallet (external)"
                    : "Account (managed)"
              }
            />
            <Row label="Order ID" value={shortId(o.id)} mono copyText={o.id} />
            <Row label="Created" value={fmtTime(o.createdAt)} />
            {o.userEvmAddress && (
              <Row
                label="Your EVM address"
                value={shortId(o.userEvmAddress)}
                mono
                copyText={o.userEvmAddress}
              />
            )}
            {o.userCantonParty && (
              <Row
                label="Your Canton party"
                value={shortId(o.userCantonParty)}
                mono
                copyText={o.userCantonParty}
              />
            )}
            {o.userTimelock ? (
              <Row
                label={`Your timelock${cantonSwap ? "" : ` (${reverse ? "Canton" : "EVM"})`}`}
                value={fmtTime(o.userTimelock)}
              />
            ) : null}
            {o.solverTimelock ? (
              <Row
                label={`Solver timelock${cantonSwap ? "" : ` (${reverse ? "EVM" : "Canton"})`}`}
                value={fmtTime(o.solverTimelock)}
              />
            ) : null}
            {/* EVM-side lock tx is the explorer-linkable one. */}
            {!cantonSwap && !reverse && o.mainLockTx && (
              <Row
                label="WBTC lock (EVM)"
                value={shortId(o.mainLockTx)}
                mono
                href={txHref(o.mainLockTx)}
              />
            )}
            {!cantonSwap && reverse && o.counterLockTx && (
              <Row
                label="WBTC lock (EVM)"
                value={shortId(o.counterLockTx)}
                mono
                href={txHref(o.counterLockTx)}
              />
            )}
            {(() => {
              const wbtcClaimTx = htlcUserWbtcClaimTx(o);
              return wbtcClaimTx ? (
                <Row
                  label="WBTC claim (EVM)"
                  value={shortId(wbtcClaimTx)}
                  mono
                  href={txHref(wbtcClaimTx)}
                />
              ) : null;
            })()}
            {o.revealedPreimage ? (
              <Row label="Secret" value="revealed ✓" />
            ) : null}
          </div>

          {cantonCounterAccept ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                The solver delivered your {o.counterLeg?.asset ?? "tokens"} —
                accept the incoming transfer in Loop to complete the swap.
              </p>
              <button
                onClick={() => onCantonCounterAccept(o)}
                disabled={busy || !loopConnected}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? "Waiting for Loop…"
                  : loopConnected
                    ? `Accept ${o.counterLeg?.asset ?? "tokens"} in Loop`
                    : "Connect Loop to accept"}
              </button>
            </div>
          ) : claimable ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                {vaultReady
                  ? o.counterMode === "loop"
                    ? "Approve the Loop unlock sign to use the saved secret, or paste it below."
                    : "Sign in with the same account to unlock the saved secret, or paste it below."
                  : o.counterMode === "loop"
                    ? "Paste the swap secret you saved when starting this swap (field below)."
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
                {busy
                  ? "Claiming…"
                  : reverse
                    ? "Claim my WBTC"
                    : "Claim my CBTC"}
              </button>
            </div>
          ) : awaitingSolver && !loopAccept ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                Your CBTC has been delivered. We&apos;re completing the final
                step on {evmChainName} — this usually finishes in under a minute.
                Refresh this page in a few seconds; no action needed from you.
              </p>
            </div>
          ) : loopAccept ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                Your secret was revealed but the CBTC transfer still needs a
                standard accept in Loop (no CBTC preapproval on this wallet
                yet).
              </p>
              <button
                onClick={() => onLoopAccept(o)}
                disabled={busy || !loopConnected}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? "Waiting for Loop…"
                  : loopConnected
                    ? "Accept CBTC in Loop"
                    : "Connect Loop to accept CBTC"}
              </button>
            </div>
          ) : loopCommitReconnect ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                Loop approved your CBTC lock, but linking the swap did not finish.
                Reconnect uses the signed transaction saved on this device — no new
                Loop sign required.
              </p>
              <button
                onClick={() => onReconnectLoopCommit(o)}
                disabled={busy}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Reconnecting…" : "Reconnect signed transaction"}
              </button>
            </div>
          ) : lockConfirm ? (
            <div className="mt-4 space-y-2">
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-700">
                This swap is waiting for your CBTC lock. If you already signed
                in Loop, confirm here (may take up to ~30s while the offer
                syncs). If the page refreshed before you signed, connect Loop
                and retry the lock.
              </p>
              <button
                onClick={() => onConfirmLock(o)}
                disabled={busy}
                className="w-full rounded-xl bg-[#b04a2a] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Confirming…" : "Confirm CBTC lock"}
              </button>
              <button
                onClick={() => onRetryLoopLock(o)}
                disabled={busy || !loopConnected}
                className="w-full rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-semibold text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
              >
                {busy
                  ? "Waiting for Loop…"
                  : loopConnected
                    ? "Retry lock in Loop"
                    : "Connect Loop to retry lock"}
              </button>
            </div>
          ) : action ? (
            <button
              onClick={() => onRecover(o, action)}
              disabled={busy}
              className="mt-4 w-full rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-semibold text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
            >
              {busy
                ? "Submitting…"
                : action === "retake-wbtc"
                  ? "Retake my WBTC"
                  : "Refund my CBTC"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
