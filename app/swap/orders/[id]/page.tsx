"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import {
  SwapWaitBanner,
  swapWaitButtonLabel
} from "@/components/SwapWaitBanner";
import {
  swapFinalizeHint,
  swapRecordingProofHint
} from "@/lib/swap-wait-copy";
import { SwapStepper } from "@/components/SwapStepper";
import { useCantonIdentity } from "@/hooks/useCantonIdentity";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useVaultContext } from "@/hooks/useVaultContext";
import { useWallet } from "@/hooks/useWallet";
import { cantonSwapApi } from "@/lib/canton-swap-client";
import {
  claimSwap,
  evmRetake,
  htlcApi
} from "@/lib/htlc-client";
import {
  isSwapClaimable
} from "@/lib/htlc-order-logic";
import type { SwapOrder } from "@/lib/htlc-types";
import { formatWbtc, HTLC_ESCROW_ADDRESS, SWAP_CHAIN } from "@/lib/swap-evm";
import { getSwapErrorMessage } from "@/lib/swap-api";
import type { CantonSwapOrder } from "@/lib/canton-swap-types";
import {
  forgetSecret,
  hasStoredSecret,
  recallSecret,
  vaultMetaFromOrder
} from "@/lib/secret-vault";
import { isReverseEvmCounterLockReady } from "@/lib/htlc-evm-counter-lock";
import {
  forwardLoopHtlcSteps,
  loopC2cSteps,
  reverseLoopHtlcSteps
} from "@/lib/swap-stepper-state";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  projectC2cStatus,
  projectHtlcStatus,
  projectedToneClass,
  type ProjectedSwapStatus
} from "@/lib/swap-status-projector";
import { htlcForwardLoopDeliveryProven, htlcVisibleCompleted } from "@/lib/swap-product-invariants";

type LoadedOrder =
  | { kind: "htlc"; order: SwapOrder }
  | { kind: "c2c"; order: CantonSwapOrder };

const HTLC_ESCROW = HTLC_ESCROW_ADDRESS;

function orderIdParam(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
}

function fmtCbtc(dec?: string): string {
  const n = Number.parseFloat(dec ?? "");
  return Number.isFinite(n)
    ? n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
    : (dec ?? "—");
}

function fmtCantonAmount(dec?: string): string {
  if (!dec) return "—";
  return trimAmount(dec);
}

function shortId(id: string): string {
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function trimAmount(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function isHtlcTerminalStatus(status: string): boolean {
  return [
    "main_claimed",
    "both_claimed",
    "refunded",
    "cancelled",
    "failed"
  ].includes(status);
}

function isC2cTerminalStatus(status: string): boolean {
  return ["filled", "failed", "expired", "cancelled"].includes(status);
}

function StatusPill({ status }: { status: ProjectedSwapStatus }) {
  return (
    <span
      className={[
        "inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset",
        projectedToneClass(status.tone)
      ].join(" ")}
    >
      {status.label}
    </span>
  );
}

function htlcPayReceive(order: SwapOrder): {
  pay: string;
  receive: string;
} {
  const wbtc = order.wbtcAmount ? formatWbtc(BigInt(order.wbtcAmount)) : "—";
  const cbtc = fmtCbtc(order.cbtcAmount);
  return order.direction === "canton-to-evm"
    ? { pay: `${cbtc} CBTC`, receive: `${wbtc} WBTC` }
    : { pay: `${wbtc} WBTC`, receive: `${cbtc} CBTC` };
}

function c2cPayReceive(order: CantonSwapOrder): {
  pay: string;
  receive: string;
} {
  return {
    pay: `${fmtCantonAmount(order.inAmount)} ${order.fromAsset}`,
    receive: `${fmtCantonAmount(order.outAmount)} ${order.toAsset}`
  };
}

function htlcPhase(
  order: SwapOrder,
  opts?: { claiming?: boolean }
): "lock" | "solver" | "claim" | "finalize" | "done" {
  if (htlcVisibleCompleted(order)) return "done";
  if (order.status === "main_claimed") return "finalize";
  if (opts?.claiming) return "claim";
  if (order.status === "counter_claimed") {
    if (
      order.direction === "evm-to-canton" &&
      order.counterMode === "loop" &&
      !htlcForwardLoopDeliveryProven(order)
    ) {
      return "claim";
    }
    return "finalize";
  }
  if (
    isSwapClaimable({
      status: order.status,
      direction: order.direction,
      counterMode: order.counterMode,
      revealedPreimage: order.revealedPreimage
    })
  ) {
    return "claim";
  }
  if (order.direction === "canton-to-evm") {
    return order.status === "accepted" ||
      order.status === "open" ||
      order.status === "main_locking"
      ? "lock"
      : "solver";
  }
  return order.status === "accepted" || order.status === "open"
    ? "lock"
    : "solver";
}

function c2cPhase(
  order: CantonSwapOrder
): "sign" | "fill" | "accept" | "done" {
  if (order.counterLegOfferCid && !order.counterReceiptUpdateId) return "accept";
  if (projectC2cStatus(order).terminal) return "done";
  if (order.status === "open") return "sign";
  return "fill";
}

export default function SwapOrderStatusPage() {
  const params = useParams<{ id?: string | string[] }>();
  const id = orderIdParam(params.id);
  const router = useRouter();
  const wallet = useWallet();
  const evm = useEvmWallet();
  const { party: sessionParty } = useCantonIdentity();
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [finalizeStartedAt, setFinalizeStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadedRef = useRef<LoadedOrder | null>(null);
  const loadInFlightRef = useRef(false);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollCountRef = useRef(0);
  const busyRef = useRef<string | null>(null);

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

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

  const loadOrder = useCallback(
    async (opts?: { light?: boolean; force?: boolean }) => {
      if (!id) return null;
      if (loadInFlightRef.current && !opts?.force) return loadedRef.current;
      loadInFlightRef.current = true;
      pollAbortRef.current?.abort();
      const ac = new AbortController();
      pollAbortRef.current = ac;
      try {
        try {
          const { order } = await htlcApi.getOrder(id, {
            light: opts?.light,
            signal: ac.signal
          });
          if (ac.signal.aborted) return loadedRef.current;
          const next = { kind: "htlc" as const, order: order as SwapOrder };
          loadedRef.current = next;
          setLoaded(next);
          setError(null);
          return next;
        } catch (e) {
          if (ac.signal.aborted) return loadedRef.current;
          if (id.startsWith("0x")) {
            setError(getSwapErrorMessage(e));
            return null;
          }
        }

        const { order } = await cantonSwapApi.get(id);
        if (ac.signal.aborted) return loadedRef.current;
        const next = { kind: "c2c" as const, order: order as CantonSwapOrder };
        loadedRef.current = next;
        setLoaded(next);
        setError(null);
        return next;
      } catch (e) {
        if (!ac.signal.aborted) setError(getSwapErrorMessage(e));
        return null;
      } finally {
        if (pollAbortRef.current === ac) {
          loadInFlightRef.current = false;
        }
      }
    },
    [id]
  );

  useEffect(() => {
    void loadOrder({ force: true });
  }, [loadOrder]);

  useEffect(() => {
    if (!loaded || loaded.kind !== "htlc") return;
    const phase = htlcPhase(loaded.order);
    if (phase === "finalize") {
      setFinalizeStartedAt((prev) => prev ?? Date.now());
    } else {
      setFinalizeStartedAt(null);
    }
  }, [loaded]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollDelayMs = () => {
      const cur = loadedRef.current;
      if (!cur) return 5_000;
      const terminal =
        cur.kind === "htlc"
          ? projectHtlcStatus(cur.order).terminal
          : projectC2cStatus(cur.order).terminal;
      if (terminal) return 0;
      if (busyRef.current) return 3_000;
      if (cur.kind === "htlc") {
        const o = cur.order;
        const recordingProof =
          o.status === "counter_claimed" &&
          o.direction === "evm-to-canton" &&
          o.counterMode === "loop" &&
          !(
            !!o.counterTransferOfferCid &&
            !htlcForwardLoopDeliveryProven(o)
          ) &&
          !htlcForwardLoopDeliveryProven(o);
        if (recordingProof) return 8_000;
        const phase = htlcPhase(cur.order);
        if (phase === "finalize" || phase === "claim") return 5_000;
      }
      return 6_000;
    };

    const tick = async () => {
      if (cancelled) return;
      const cur = loadedRef.current;
      const terminal =
        cur &&
        (cur.kind === "htlc"
          ? projectHtlcStatus(cur.order).terminal
          : projectC2cStatus(cur.order).terminal);
      if (terminal) return;
      pollCountRef.current += 1;
      const curOrder = loadedRef.current?.kind === "htlc" ? loadedRef.current.order : null;
      const needsFullReconcile =
        !!curOrder &&
        (curOrder.status === "counter_claimed" ||
          curOrder.status === "main_claimed") &&
        !projectHtlcStatus(curOrder).proofComplete;
      await loadOrder({
        light: !(needsFullReconcile && pollCountRef.current % 2 === 0)
      });
      if (cancelled) return;
      const delay = pollDelayMs();
      if (delay > 0) timer = setTimeout(() => void tick(), delay);
    };

    timer = setTimeout(() => void tick(), 4_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      pollAbortRef.current?.abort();
    };
  }, [id, loadOrder]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));

  const recoverSecret = useCallback(
    async (order: SwapOrder): Promise<string | null> => {
      return recallSecret(order.id, {
        ...(await vaultContext()),
        orderMeta:
          vaultMetaFromOrder({
            direction: order.direction,
            counterMode: order.counterMode,
            userCantonParty: order.userCantonParty,
            userEvmAddress: order.userEvmAddress,
            userTimelock: order.userTimelock,
            solverTimelock: order.solverTimelock
          }) ?? undefined
      });
    },
    [vaultContext]
  );

  const doClaim = useCallback(async () => {
    if (!loaded || loaded.kind !== "htlc") return;
    const order = loaded.order;
    setBusy("claim");
    setError(null);
    try {
      const loopAcceptPending =
        order.direction === "evm-to-canton" &&
        order.counterMode === "loop" &&
        order.status === "counter_claimed" &&
        !!order.counterTransferOfferCid &&
        !htlcForwardLoopDeliveryProven(order);
      const secret = loopAcceptPending
        ? order.revealedPreimage ?? (await recoverSecret(order))
        : await recoverSecret(order);
      if (!secret) {
        throw new Error(
          loopAcceptPending
            ? "This swap's revealed preimage is not visible yet. Refresh Orders and try accepting again."
            : hasStoredSecret(order.id)
            ? "Could not unlock the saved secret. Connect the same wallet/account and try again."
            : "This swap's secret is not available on this device."
        );
      }
      if (order.direction === "canton-to-evm") {
        const probe = await isReverseEvmCounterLockReady({
          hashLock: order.hashLock ?? order.id,
          wbtcAmount: order.wbtcAmount ?? "0",
          userEvmAddress: order.userEvmAddress ?? evm.account ?? ""
        });
        if (!probe.ready) throw new Error(probe.reason);
      }
      await claimSwap({
        order: {
          id: order.id,
          direction: order.direction,
          counterMode: order.counterMode
        },
        secret,
        escrow: HTLC_ESCROW,
        send: evm.sendTransaction,
        loop: wallet.provider as unknown as {
          party_id?: string;
          submitAndWaitForTransaction: (
            payload: unknown,
            options?: unknown
          ) => Promise<unknown>;
        } | null
      });
      forgetSecret(order.id);
      setBusy("confirming");
      await loadOrder({ force: true });
      for (let attempt = 0; attempt < 30; attempt++) {
        const fresh = await loadOrder({ force: true });
        const row =
          fresh?.kind === "htlc"
            ? fresh.order
            : loadedRef.current?.kind === "htlc"
              ? loadedRef.current.order
              : null;
        if (!row) break;
        if (projectHtlcStatus(row).proofComplete) break;
        if (
          row.direction === "canton-to-evm" &&
          row.status === "main_claimed" &&
          !!row.mainClaimTx
        ) {
          break;
        }
        if (
          row.status === "counter_claimed" &&
          row.direction === "evm-to-canton" &&
          row.counterMode === "loop" &&
          htlcForwardLoopDeliveryProven(row)
        ) {
          break;
        }
        const stillAcceptPending =
          row.status === "counter_claimed" &&
          row.direction === "evm-to-canton" &&
          row.counterMode === "loop" &&
          !!row.counterTransferOfferCid &&
          !htlcForwardLoopDeliveryProven(row);
        if (!stillAcceptPending && attempt > 3) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      const msg = getSwapErrorMessage(e);
      try {
        const fresh = await loadOrder({ force: true });
        const row =
          fresh?.kind === "htlc"
            ? fresh.order
            : loadedRef.current?.kind === "htlc"
              ? loadedRef.current.order
              : null;
        if (
          row &&
          (projectHtlcStatus(row).proofComplete ||
            row.status === "main_claimed" ||
            (row.status === "counter_claimed" && !!row.mainClaimTx))
        ) {
          setError(null);
          return;
        }
      } catch {
        /* fall through */
      }
      setError(msg);
    } finally {
      setBusy(null);
    }
  }, [evm.sendTransaction, loadOrder, loaded, recoverSecret, wallet.provider]);

  const doRecover = useCallback(async () => {
    if (!loaded || loaded.kind !== "htlc") return;
    const order = loaded.order;
    setBusy("recover");
    setError(null);
    try {
      if (order.direction === "evm-to-canton") {
        if (!evm.account) throw new Error("Connect your EVM wallet first.");
        const tx = await evmRetake(evm.sendTransaction, HTLC_ESCROW, order.id);
        await evm.waitForReceipt(tx);
        await htlcApi.recordRetake(order.id, tx);
      } else {
        await htlcApi.refundMain(order.id);
      }
      forgetSecret(order.id);
      await loadOrder();
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [evm, loadOrder, loaded]);

  const doConfirmC2cAccept = useCallback(async () => {
    if (!loaded || loaded.kind !== "c2c") return;
    const loop = wallet.provider;
    if (!loop) {
      setError("Connect Loop wallet to accept incoming tokens.");
      return;
    }
    setBusy("accept");
    setError(null);
    try {
      const prep = await cantonSwapApi.prepareCounterAccept(loaded.order.id);
      const userParty = loaded.order.userParty ?? wallet.partyId ?? "";
      await loop.submitAndWaitForTransaction({
        commands: [prep.command],
        disclosedContracts: prep.disclosedContracts,
        packageIdSelectionPreference: [],
        actAs: [userParty],
        readAs: [userParty],
        synchronizerId: prep.synchronizerId
      });
      await cantonSwapApi.confirmCounterAccept(loaded.order.id);
      await loadOrder();
    } catch (e) {
      setError(getSwapErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [loadOrder, loaded, wallet.partyId, wallet.provider]);

  const main = useMemo(() => {
    if (!loaded) return null;
    if (loaded.kind === "c2c") {
      const order = loaded.order;
      const { pay, receive } = c2cPayReceive(order);
      const phase = c2cPhase(order);
      const projected = projectC2cStatus(order);
      const pendingCounterAccept =
        !!order.counterLegOfferCid && !order.counterReceiptUpdateId;
      return {
        id: order.id,
        status: projected,
        terminal: projected.terminal,
        title:
          projected.terminal && order.status === "filled"
            ? "Swap complete"
            : order.status === "failed" || order.status === "expired"
              ? "Swap needs attention"
              : pendingCounterAccept
                ? "Accept incoming tokens"
              : swapWaitButtonLabel(elapsedSec, "settling"),
        subtitle:
          order.failureReason ??
          (projected.terminal && order.status === "filled"
            ? order.toAsset === "CC" &&
              !order.counterLegOfferCid &&
              order.counterReceiptUpdateId
              ? `${trimAmount(order.outAmount)} CC was credited to your Loop wallet via auto-accept. Check your CC balance in the header — Loop does not show a separate incoming transfer for this path.`
              : "Your swap settled on Canton."
            : pendingCounterAccept
              ? order.walletMode === "managed"
                ? "The solver delivered your tokens."
                : "The solver delivered your tokens — accept the incoming transfer in Loop."
              : "Settlement is in progress on Canton — usually under a minute."),
        pay,
        receive,
        steps: loopC2cSteps({
          phase,
          managed: order.walletMode === "managed",
          directCounterDelivery:
            projected.terminal &&
            !order.counterLegOfferCid &&
            !!order.counterReceiptUpdateId
        }),
        claimable: false,
        claiming: false,
        c2cAccept: pendingCounterAccept,
        recoverable: false,
        reverse: false,
        mode: "settling" as const
      };
    }

    const order = loaded.order;
    const reverse = order.direction === "canton-to-evm";
    const claimInFlight = busy === "claim" || busy === "confirming";
    const phase = htlcPhase(order, { claiming: claimInFlight });
    const { pay, receive } = htlcPayReceive(order);
    const projected = projectHtlcStatus(order);
    const loopAcceptPending =
      order.direction === "evm-to-canton" &&
      order.counterMode === "loop" &&
      order.status === "counter_claimed" &&
      !!order.counterTransferOfferCid &&
      !htlcForwardLoopDeliveryProven(order);
    const loopUserLegDone =
      order.direction === "evm-to-canton" &&
      order.counterMode === "loop" &&
      order.status === "counter_claimed" &&
      htlcForwardLoopDeliveryProven(order);
    const recordingProof =
      order.status === "counter_claimed" &&
      order.direction === "evm-to-canton" &&
      order.counterMode === "loop" &&
      !loopAcceptPending &&
      !loopUserLegDone;
    const finalizing =
      phase === "finalize" ||
      (order.status === "main_claimed" && !projected.proofComplete);
    const finalizeElapsedSec = finalizeStartedAt
      ? Math.max(0, Math.floor((now - finalizeStartedAt) / 1000))
      : elapsedSec;
    const claimable =
      !claimInFlight &&
      !recordingProof &&
      (loopAcceptPending ||
        isSwapClaimable({
          status: order.status,
          direction: order.direction,
          counterMode: order.counterMode,
          revealedPreimage: order.revealedPreimage
        }));
    const reverseLocking = reverse && phase === "lock";
    const recoverable =
      !claimable &&
      !claimInFlight &&
      !order.revealedPreimage &&
      (order.status === "main_locked" || order.status === "counter_locked") &&
      !!order.userTimelock &&
      Math.floor(now / 1000) >= order.userTimelock;
    const title = (() => {
      if (projected.terminal) return "Swap complete";
      if (order.status === "refunded") return "Swap refunded";
      if (claimInFlight) return reverse ? "Claiming WBTC..." : loopAcceptPending ? "Accepting CBTC..." : "Claiming CBTC...";
      if (recordingProof) return "Confirming CBTC delivery…";
      if (finalizing) return "Finalizing swap";
      if (claimable) {
        if (loopAcceptPending) return "Accept your CBTC";
        return reverse
          ? "Both legs locked — claim your WBTC"
          : "Both legs locked — claim your CBTC";
      }
      if (reverseLocking) {
        return order.counterMode === "loop"
          ? "Confirming CBTC transfer..."
          : "Locking CBTC on Canton...";
      }
      return reverse
        ? swapWaitButtonLabel(elapsedSec, "solver", true)
        : swapWaitButtonLabel(
            elapsedSec,
            "solver",
            false,
            order.counterMode === "managed"
          );
    })();
    const subtitle = (() => {
      if (projected.terminal) return "Funds delivered.";
      if (order.status === "refunded") return "Your locked funds were returned.";
      if (claimInFlight) {
        if (busy === "confirming") {
          return swapRecordingProofHint(
            Math.max(0, Math.floor((now - startedAt) / 1000))
          );
        }
        return reverse
          ? "Confirming your WBTC claim and recording the reveal."
          : loopAcceptPending
            ? "Waiting for Loop to confirm your CBTC accept."
            : "Confirming your CBTC claim and recording the reveal.";
      }
      if (recordingProof) {
        return swapRecordingProofHint(
          Math.max(0, Math.floor((now - startedAt) / 1000))
        );
      }
      if (finalizing) {
        return swapFinalizeHint({
          elapsedSec: finalizeElapsedSec,
          reverse,
          chainName: SWAP_CHAIN.name
        });
      }
      if (claimable) {
        if (loopAcceptPending) {
          return "Accept the incoming CBTC transfer in Loop to finish your side of the swap.";
        }
        return reverse
          ? "Claim WBTC in your EVM wallet. This reveals the secret so the solver can complete the Canton leg."
          : "Claim CBTC to reveal your secret and complete the atomic link.";
      }
      if (reverseLocking) {
        return order.counterMode === "loop"
          ? "Your Loop transfer was submitted. Waiting for it to become visible on Canton so the solver can continue."
          : "Your CBTC is being locked on Canton by the platform.";
      }
      return reverse
        ? `Your CBTC is locked. Waiting for the solver to lock WBTC on ${SWAP_CHAIN.name}.`
        : "Your WBTC is locked. The solver is locking CBTC on Canton — usually under a minute.";
    })();
    return {
      id: order.id,
      status: projected,
      terminal: projected.terminal,
      title,
      subtitle,
      pay,
      receive,
      steps: reverse
        ? reverseLoopHtlcSteps({
            phase,
            chainName: SWAP_CHAIN.name,
            managed: order.counterMode === "managed"
          })
        : forwardLoopHtlcSteps({
            phase,
            networkFeeEnabled: false,
            managed: order.counterMode === "managed",
            chainName: SWAP_CHAIN.name
          }),
      claimable,
      claiming: claimInFlight,
      finalizing,
      recordingProof,
      c2cAccept: false,
      recoverable,
      reverse,
      mode: reverseLocking ? ("locking" as const) : ("solver" as const)
    };
  }, [busy, elapsedSec, finalizeStartedAt, loaded, now, startedAt]);

  if (!id) {
    return (
      <SwapStatusShell>
        <p className="text-sm text-destructive">Missing swap order id.</p>
      </SwapStatusShell>
    );
  }

  if (!loaded || !main) {
    return (
      <SwapStatusShell>
        <div className="flex flex-col items-center py-10 text-center">
          <span className="mb-4 inline-block size-7 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="text-sm text-muted-foreground">Loading swap status…</p>
        </div>
      </SwapStatusShell>
    );
  }

  const ordersHref = `/orders?id=${encodeURIComponent(main.id)}${
    loaded.kind === "c2c" ? "&kind=canton-swap" : ""
  }`;
  const forwardManaged =
    loaded.kind === "htlc" && loaded.order.counterMode === "managed";
  const showWaitBanner =
    !main.terminal && !main.claimable && !main.c2cAccept && !main.claiming;

  return (
    <SwapStatusShell>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {main.title}
          </h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {main.subtitle}
          </p>
        </div>
        <StatusPill status={main.status} />
      </div>

      <SwapStepper steps={main.steps} />

      <div className="overflow-hidden rounded-2xl bg-muted/40">
        <div className="flex items-center justify-between gap-3 border-b border-foreground/5 px-4 py-3">
          <span className="text-sm text-muted-foreground">You pay</span>
          <span className="text-sm font-semibold tabular-nums">{main.pay}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-muted-foreground">You receive</span>
          <span className="text-sm font-semibold tabular-nums">
            {main.receive}
          </span>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          {error}
        </p>
      )}

      {main.claiming && !main.claimable && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-foreground/10 bg-muted/30 px-4 py-3">
          <span className="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <p className="text-sm text-muted-foreground">{main.subtitle}</p>
        </div>
      )}

      {!main.claiming && (main.finalizing || main.recordingProof) && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <span className="mt-0.5 inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-amber-600/30 border-t-amber-600" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {main.recordingProof
                ? "Confirming CBTC delivery"
                : main.reverse
                  ? "Waiting for solver settlement on Canton"
                  : "Waiting for solver settlement"}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {main.subtitle}
            </p>
          </div>
        </div>
      )}

      {main.claimable && (
        <button
          type="button"
          onClick={doClaim}
          disabled={!!busy}
          className="mt-4 w-full rounded-2xl bg-[#b04a2a] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "claim"
            ? "Claiming…"
            : main.status.label === "Accept pending"
              ? "Accept CBTC"
            : main.reverse
              ? "Claim WBTC"
              : "Claim CBTC"}
        </button>
      )}

      {main.c2cAccept && (
        <button
          type="button"
          onClick={doConfirmC2cAccept}
          disabled={!!busy}
          className="mt-4 w-full rounded-2xl bg-[#b04a2a] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "accept" ? "Waiting for Loop…" : "Accept incoming tokens"}
        </button>
      )}

      {main.recoverable && (
        <button
          type="button"
          onClick={doRecover}
          disabled={!!busy}
          className="mt-4 w-full rounded-2xl border border-foreground/15 px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
        >
          {busy === "recover"
            ? "Submitting…"
            : main.reverse
              ? "Refund my CBTC"
              : "Retake my WBTC"}
        </button>
      )}

      {showWaitBanner && (
        <SwapWaitBanner
          elapsedSec={elapsedSec}
          mode={main.mode}
          orderId={main.id}
          ordersHref={ordersHref}
          reverse={main.reverse}
          forwardManaged={forwardManaged}
          onStartNewSwap={() => router.push("/swap")}
        />
      )}

      {!showWaitBanner && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Link
            href={ordersHref}
            className="rounded-2xl border border-foreground/15 px-4 py-2.5 text-center text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5"
          >
            View in Orders
          </Link>
          <Link
            href="/swap"
            className="rounded-2xl border border-foreground/10 px-4 py-2.5 text-center text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            Start a new swap
          </Link>
        </div>
      )}

      {!showWaitBanner && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Order {shortId(main.id)}
        </p>
      )}
    </SwapStatusShell>
  );
}

function SwapStatusShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[620px] flex-col px-4 py-10">
      <div className="rounded-[28px] border border-foreground/10 bg-card p-6 shadow-sm">
        {children}
      </div>
    </main>
  );
}
