"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ChainIcon } from "@/components/ChainIcon";
import { LoopWalletHint } from "@/components/LoopWalletHint";
import {
  SwapWaitBanner,
  swapWaitButtonLabel
} from "@/components/SwapWaitBanner";
import { SwapStepper } from "@/components/SwapStepper";
import { TokenIcon, type SwapTokenId } from "@/components/TokenIcon";
import { SwapLegBadge } from "@/components/SwapLegPicker";
import { useCantonIdentity } from "@/hooks/useCantonIdentity";
import { useManagedPreapproval } from "@/hooks/useManagedPreapproval";
import {
  useCantonSwapAssets,
  type CantonSwapAssetMeta
} from "@/hooks/useCantonSwapAssets";
import { useCantonLiveQuote } from "@/hooks/useCantonLiveQuote";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWallet";
import { useVaultContext } from "@/hooks/useVaultContext";
import { useBalance } from "@/hooks/useBalance";
import { useInvalidateBalances } from "@/hooks/useInvalidateBalances";
import {
  hasCbtcAutoAccept,
  swapSessionActive,
  mintSwapSessionDetailed
} from "@/lib/swap-accept";
import { truncatePartyId } from "@/lib/format";
import { toBaseUnits } from "@/lib/amount-units";
import { getSwapAsset, type CantonSwapAssetId } from "@/lib/canton-assets";
import {
  checkSwapPayAmountLimit,
  swapPayAssetFromToken
} from "@/lib/swap-amount-limits";
import {
  loopSettingsUrl,
  DEFAULT_PLATFORM_FEE_BPS
} from "@/lib/constants";
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { cn } from "@/lib/utils";
import {
  getQuote,
  submitOrder,
  getSwapErrorMessage,
  needsHtlcLoopLockConfirm,
  isUserRejection,
  ApiError,
  type QuoteResponse
} from "@/lib/swap-api";
import {
  PERMIT2_ADDRESS,
  SWAP_CHAIN,
  HTLC_ESCROW_ADDRESS,
  encodeApprove,
  encodeAllowance,
  encodeBalanceOf,
  decodeUint,
  formatWbtc,
  parseWbtc,
  sanitizeAmountInput,
  cleanPastedAmount,
  truncateToDecimals
} from "@/lib/swap-evm";
import {
  generateSecret,
  secretToPreimage,
  htlcApi,
  claimSwap,
  evmApproveAndLock,
  evmClaim,
  evmRetake,
  loopSubmitUpdateId
} from "@/lib/htlc-client";
import {
  EvmTxRevertedError,
  getBrowserEvmProvider,
  getEvmReceiptState
} from "@/lib/evm-wait-receipt";
import {
  forgetPendingMainLock,
  readPendingMainLocks,
  rememberPendingMainLock,
  selectPendingMainLock,
  type PendingMainLock
} from "@/lib/htlc-pending-main-lock";
import {
  listLoopCbtcHoldingCids,
  listLoopInstrumentHoldingCids
} from "@/lib/loop-holdings";
import { cantonSwapApi } from "@/lib/canton-swap-client";
import {
  clearPendingLoopCommit,
  patchPendingLoopCommit,
  pendingC2cMatchesQuote,
  pendingForwardMatchesQuote,
  pendingReverseMatchesQuote,
  readPendingLoopCommit,
  writePendingLoopCommit
} from "@/lib/swap-pending-loop-commit";
import { ensureHtlcSecretVaulted, HTLC_VAULT_FAIL_MSG, recallHtlcConfirmSecret, resolveHtlcClaimSecret } from "@/lib/htlc-secret-resolver";
import { logNetworkFeeInBrowser } from "@/lib/network-fee-client-log";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { htlcUserWbtcClaimTx } from "@/lib/htlc-order-logic";
import { isReverseEvmCounterLockReady } from "@/lib/htlc-evm-counter-lock";
import {
  forgetSecret,
  readActiveHtlcSwap,
  dismissActiveHtlcSwap,
  vaultMetaFromOrder,
  type SecretVaultMeta
} from "@/lib/secret-vault";
import {
  SWAP_WAIT_POLL_MS,
  LOOP_POPUP_BLOCKED_HINT,
  LOOP_POPUP_STALLED_HINT,
  LOOP_WALLET_PENDING_HINT,
  LOOP_WALLET_POPUP_HINT,
  swapWaitTerminalMessage
} from "@/lib/swap-wait-copy";
import {
  isPopupBlocked,
  isLoopPopupBlockedError,
  openLoopWalletTab
} from "@/lib/loop-popup";
import {
  timelocksFromExpiration,
  timelocksFromExpirationCanton,
  EXPIRATION_OPTIONS,
  DEFAULT_EXPIRATION_SECONDS
} from "@/lib/htlc-timelock";
import type { SwapLeg } from "@/lib/swap-leg";
import {
  applyLegChange,
  normalizeSwapLegs,
  resolveSwapKind
} from "@/lib/swap-leg";
import { formatCantonQuoteError } from "@/lib/canton-quote-messages";
import { formatSettlementError } from "@/lib/swap-settlement-messages";
import {
  forwardLoopHtlcSteps,
  loopC2cSteps
} from "@/lib/swap-stepper-state";
import { projectC2cStatus, projectHtlcStatus } from "@/lib/swap-status-projector";
import {
  quoteOutUnits,
  quoteGrossOutUnits
} from "@/lib/htlc-quote-math";
import {
  extractCreatedOfferCid,
  extractEventsByIdFromSubmitResult,
  extractLastCreatedOfferCid,
  extractSubmitUpdateId
} from "@/lib/mint-processor-logic";

function publicEnvFlagEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().replace(/\s+#.*$/, "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const NETWORK_FEE_UI_ENABLED = publicEnvFlagEnabled(
  process.env.NEXT_PUBLIC_NETWORK_FEE_ENABLED
);

function quoteExpiresAtSeconds(quote: QuoteResponse): number | undefined {
  return quote.expiresAt ?? quote.expires;
}

function quoteIsExpired(
  quote: QuoteResponse,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  const expiresAt = quoteExpiresAtSeconds(quote);
  return typeof expiresAt === "number" && nowSec >= expiresAt;
}

function formatQuoteCountdown(secondsRemaining: number): string {
  const total = Math.max(0, Math.ceil(secondsRemaining));
  if (total <= 0) return "Expired";
  if (total < 60) return `in ${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds > 0 ? `in ${minutes}m ${seconds}s` : `in ${minutes}m`;
}

// HTLC EVM leg config (Base Sepolia). The new trustless escrow (replaces the old
// oracle InputSettlerEscrow for swaps). Shared resolver fails closed in production.
const HTLC_ESCROW = HTLC_ESCROW_ADDRESS;
const SOLVER_EVM =
  process.env.NEXT_PUBLIC_SOLVER_EVM ??
  "0x0B95ec21579aee6Ef7b712976bD86689D68b5A08";
/** Canton settlement vault — CBTC float + HTLC counter legs (not the node fee party). */
const SETTLEMENT_PARTY =
  process.env.NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY ?? "";
const SOLVER_CANTON = SETTLEMENT_PARTY;

type Stage =
  | { kind: "idle" }
  | { kind: "redirecting"; orderId: string }
  | { kind: "quoting" }
  // `retryError` lets a rejected approve/sign return to the quote (don't lose it).
  | { kind: "quoted"; quote: QuoteResponse; retryError?: string }
  | { kind: "approving"; quote: QuoteResponse }
  | { kind: "signing"; quote: QuoteResponse }
  | { kind: "submitting"; quote: QuoteResponse; c2cPhase?: "sign" | "confirm" }
  // HTLC: waiting for the independent solver to lock the CBTC counter.
  | {
      kind: "htlc-locking";
      quote: QuoteResponse;
      swapId: string;
      secret: string;
      lockTx: string;
      userCantonParty: string;
      userEvmAddress: string;
      waitStartedAt: number;
      /** Set when the lock submitted but recording mainLockTx failed. This is
       *  recovery state only; do not show noisy internal recovery copy in the UI. */
      recordingRecovery?: true;
    }
  // HTLC: a submitted EVM lock is being confirmed and durably recorded.
  | {
      kind: "htlc-recording";
      swapId: string;
      lockTx: string;
      userCantonParty: string;
      userEvmAddress: string;
      waitStartedAt: number;
    }
  // HTLC: both legs locked — the USER can now claim (press to reveal).
  | {
      kind: "htlc-claimable";
      swapId: string;
      secret: string;
      lockTx: string;
      claimError?: string;
    }
  // HTLC: refresh detected a claimable swap — user must unlock vault before claim.
  | {
      kind: "htlc-resume";
      swapId: string;
      lockTx: string;
      unlockError?: string;
    }
  // HTLC: the user's claim (reveal) is in flight.
  | { kind: "htlc-claiming"; swapId: string; secret: string; lockTx: string }
  // HTLC swap completed. swapId = hashLock.
  | {
      kind: "htlc-done";
      swapId: string;
      lockTx: string;
      wbtcAmount?: string;
      cbtcAmount?: string;
    }
  // HTLC: the user retook (refunded) their WBTC after a stuck swap.
  | { kind: "htlc-refunded"; swapId: string; retakeTx: string }
  // ===== REVERSE (canton-to-evm): sell CBTC, receive WBTC =====
  // rev-locking: backend locks the user's CBTC on-ledger, then waits for the
  // solver's WBTC counter-lock. rev-claimable: user claims WBTC in MetaMask
  // (= the secret reveal). rev-done: WBTC claimed; the solver claims the CBTC.
  | {
      kind: "rev-locking";
      swapId: string;
      secret: string;
      phase?: "custody" | "solver";
      waitStartedAt?: number;
      counterMode?: "managed" | "loop";
      /** Shown when DB says counter_locked but on-chain WBTC lock is missing. */
      solverNote?: string;
    }
  | {
      kind: "rev-claimable";
      swapId: string;
      secret: string;
      claimError?: string;
      hashLock?: string;
      wbtcAmount?: string;
      userEvmAddress?: string;
      cbtcAmount?: string;
    }
  | { kind: "rev-resume"; swapId: string; unlockError?: string }
  | { kind: "rev-claiming"; swapId: string; secret: string }
  | {
      kind: "rev-done";
      swapId: string;
      claimTx: string;
      wbtcAmount?: string;
      cbtcAmount?: string;
      /** True when WBTC claim landed but solver has not finished the Canton leg. */
      settling?: boolean;
    }
  | {
      kind: "c2c-done";
      orderId: string;
      fromAsset: string;
      toAsset: string;
      inAmount: string;
      outAmount: string;
      walletMode: "managed" | "loop";
      /** Counter CC/CBTC landed via preapproval — no Loop accept prompt. */
      directCounterDelivery?: boolean;
    }
  | {
      kind: "c2c-waiting";
      orderId: string;
      fromAsset: string;
      toAsset: string;
      inAmount: string;
      outAmount: string;
      note?: string;
      waitStartedAt: number;
    }
  | { kind: "error"; message: string };

/** Temporary estimate until the authoritative server price response arrives. */
const FEE_BPS = DEFAULT_PLATFORM_FEE_BPS;

export default function SwapPage() {
  const evm = useEvmWallet();
  const wallet = useWallet();
  const {
    party: sessionParty,
    ready: identityReady,
    authed: sessionReadyAuth,
    isManaged: isParticipantManagedFromSession
  } = useCantonIdentity();
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
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

  const identityProbed = identityReady;

  const destinationParty =
    process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ?? sessionParty ?? wallet.partyId;
  const loopConnected = !!destinationParty;

  const router = useRouter();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SWAP_DEST_PARTY) return;
    if (!identityProbed || wallet.isLoading) return;
    if (!destinationParty) router.replace("/login");
  }, [identityProbed, wallet.isLoading, destinationParty, router]);

  const isParticipantManaged =
    isParticipantManagedFromSession &&
    !!sessionParty &&
    destinationParty === sessionParty;

  const vaultRecallContext = useVaultContext({
    loopProvider: wallet.provider,
    evmAddress: evm.account,
    sessionUserId,
    sessionPartyId: sessionParty
  });

  const ensureSwapSecret = useCallback(
    async (
      swapId: string,
      secret: string,
      meta: Omit<SecretVaultMeta, "expiresAt"> & {
        userTimelock: number;
        solverTimelock?: number;
      }
    ) => {
      await ensureHtlcSecretVaulted(
        swapId,
        secret,
        meta,
        await vaultRecallContext()
      );
    },
    [vaultRecallContext]
  );

  // Amount starts EMPTY (CoW-style) — no default value. The input shows its "0.0"
  // placeholder and the button reads "Enter an amount" until the user types. All
  // downstream logic (receiveEstimate, amountState) already treats "" as not-set.
  const [amount, setAmount] = useState("");
  /** Pay / receive legs — network + token selectors on the unified swap card. */
  const [payLeg, setPayLeg] = useState<SwapLeg>({
    chain: "evm",
    token: "WBTC"
  });
  const [receiveLeg, setReceiveLeg] = useState<SwapLeg>({
    chain: "canton",
    token: "CBTC"
  });
  const swapKind = useMemo(
    () => resolveSwapKind(payLeg, receiveLeg),
    [payLeg, receiveLeg]
  );
  const isC2c = swapKind === "canton-to-canton";
  const direction =
    swapKind === "canton-to-evm"
      ? "canton-to-evm"
      : swapKind === "evm-to-canton"
        ? "evm-to-canton"
        : "evm-to-canton";
  const isReverse = swapKind === "canton-to-evm";
  const { data: cantonAssets = [], isLoading: assetsLoading } =
    useCantonSwapAssets();
  const enabledCantonIds = useMemo(
    () => cantonAssets.map((a) => a.id),
    [cantonAssets]
  );
  // Order expiration (Cancore §8) → drives the staggered HTLC timelocks.
  const [expirationSeconds, setExpirationSeconds] = useState<number>(
    DEFAULT_EXPIRATION_SECONDS
  );
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const changePayLeg = useCallback(
    (next: SwapLeg) => {
      const { pay, receive } = applyLegChange(
        "pay",
        next,
        payLeg,
        receiveLeg,
        enabledCantonIds
      );
      setPayLeg(pay);
      setReceiveLeg(receive);
      setStage({ kind: "idle" });
    },
    [payLeg, receiveLeg, enabledCantonIds]
  );

  const changeReceiveLeg = useCallback(
    (next: SwapLeg) => {
      const { pay, receive } = applyLegChange(
        "receive",
        next,
        payLeg,
        receiveLeg,
        enabledCantonIds
      );
      setPayLeg(pay);
      setReceiveLeg(receive);
      setStage({ kind: "idle" });
    },
    [payLeg, receiveLeg, enabledCantonIds]
  );

  // Drop stale CC-guard errors (older builds blocked email users at 0 CC).
  useEffect(() => {
    if (
      stage.kind === "error" &&
      stage.message.includes("Insufficient CC for Canton network fees")
    ) {
      setStage({ kind: "idle" });
    }
  }, [stage]);

  // Clear stale settlement errors when amount changes (not on every render).
  const prevAmountRef = useRef(amount);
  useEffect(() => {
    if (prevAmountRef.current !== amount && stage.kind === "error") {
      setStage({ kind: "idle" });
    }
    prevAmountRef.current = amount;
  }, [amount, stage.kind]);
  const activeMainLockRecordingRef = useRef<string | null>(null);

  const [wbtcBalance, setWbtcBalance] = useState<bigint | null>(null);
  /** Live WBTC/BTC from GET /api/htlc/price — same cache as server quotes. */
  const [wbtcPrice, setWbtcPrice] = useState<{
    raw: bigint;
    feeBps: number;
  } | null>(null);
  const [wbtcPriceError, setWbtcPriceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadPrice = async () => {
      try {
        const res = await fetch("/api/htlc/price", { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!cancelled) {
            setWbtcPriceError(
              body.error ||
                `WBTC/BTC price unavailable (HTTP ${res.status}). Try again shortly.`
            );
          }
          return;
        }
        const body = (await res.json()) as {
          wbtcPriceRaw?: string;
          feeBps?: number;
        };
        if (!body.wbtcPriceRaw || cancelled) return;
        setWbtcPrice({
          raw: BigInt(body.wbtcPriceRaw),
          feeBps: body.feeBps ?? FEE_BPS
        });
        setWbtcPriceError(null);
      } catch {
        if (!cancelled) {
          setWbtcPriceError("WBTC/BTC price unavailable. Try again shortly.");
        }
      }
    };
    void loadPrice();
    const id = setInterval(loadPrice, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // In-flight swaps are tracked on /orders — not on this page.
  const {
    total: cbtcBalance,
    ccTotal,
    isLoading: balanceLoading
  } = useBalance();
  const invalidateBalances = useInvalidateBalances();
  const usdcxEnabled = cantonAssets.some((a) => a.id === "USDCX");
  const { data: usdcxBalance = "0", isLoading: usdcxLoading } = useQuery({
    queryKey: ["asset-balance", "USDCX"],
    queryFn: async () => {
      const r = await fetch("/api/parties/asset-balance?asset=USDCX");
      if (!r.ok) return "0";
      const j = (await r.json()) as { total?: string };
      return j.total ?? "0";
    },
    enabled: usdcxEnabled,
    refetchInterval: 30_000
  });

  const balanceForLeg = useCallback(
    (leg: SwapLeg): string | undefined => {
      if (leg.chain === "evm") {
        return wbtcBalance != null ? formatWbtc(wbtcBalance) : undefined;
      }
      if (leg.token === "CBTC") return cbtcBalance || undefined;
      if (leg.token === "CC") return ccTotal ?? undefined;
      if (leg.token === "USDCX") return usdcxBalance;
      return undefined;
    },
    [wbtcBalance, cbtcBalance, ccTotal, usdcxBalance]
  );

  const c2cFromAsset = payLeg.chain === "canton" ? payLeg.token : null;
  const c2cToAsset = receiveLeg.chain === "canton" ? receiveLeg.token : null;
  const {
    data: c2cLiveQuote,
    isFetching: c2cQuoteLoading,
    isError: c2cQuoteIsError,
    error: c2cQuoteError
  } = useCantonLiveQuote({
    enabled: isC2c && !!destinationParty,
    fromAsset: c2cFromAsset,
    toAsset: c2cToAsset,
    amount,
    userParty: destinationParty
  });

  const c2cQuoteOutAmount =
    (stage.kind === "quoted" || stage.kind === "submitting") &&
    stage.quote.outAmount
      ? stage.quote.outAmount
      : c2cLiveQuote?.outAmount;

  const {
    data: managedPreapproval,
    isLoading: managedPreapprovalLoading,
    needsEnableCc,
    needsEnableCbtc,
    needsCcDeposit,
    enabling: enablingCc,
    enablingCbtc,
    enableError: enableCcError,
    enableCc,
    enableCbtc,
    enableAllPreapprovals,
    refetch: refetchManagedPreapproval
  } = useManagedPreapproval({
    enabled:
      isParticipantManaged &&
      isC2c &&
      (stage.kind === "quoted" || stage.kind === "submitting"),
    fromAsset: c2cFromAsset ?? undefined,
    toAsset: c2cToAsset ?? undefined,
    inAmount: amount || undefined,
    outAmount: c2cQuoteOutAmount
  });

  useEffect(() => {
    if (
      stage.kind === "htlc-done" ||
      stage.kind === "rev-done" ||
      stage.kind === "c2c-done"
    ) {
      invalidateBalances();
    }
  }, [stage.kind, invalidateBalances]);

  useEffect(() => {
    if (stage.kind !== "c2c-waiting") return;
    const { orderId, fromAsset, toAsset, inAmount, outAmount } = stage;
    let cancelled = false;

    const poll = async () => {
      try {
        const { order } = await cantonSwapApi.get(orderId);
        if (cancelled) return;

        if (projectC2cStatus(order).terminal) {
          setStage({
            kind: "c2c-done",
            orderId,
            fromAsset,
            toAsset,
            inAmount,
            outAmount,
            walletMode: "loop",
            directCounterDelivery:
              !order.counterLegOfferCid && !!order.counterReceiptUpdateId
          });
          return;
        }

        if (
          order.counterLegOfferCid &&
          !order.counterReceiptUpdateId
        ) {
          setStage((s) =>
            s.kind === "c2c-waiting"
              ? {
                  ...s,
                  note: "Solver delivered your tokens — accept the incoming transfer in Loop (see Orders)."
                }
              : s
          );
          return;
        }

        if (order.status === "failed" || order.status === "expired") {
          setStage({
            kind: "error",
            message: formatSettlementError(
              order.failureReason ?? `Swap ${order.status}`
            )
          });
          return;
        }

        if (
          order.failureReason &&
          (order.status === "filling" || order.status === "user_locked")
        ) {
          setStage((s) =>
            s.kind === "c2c-waiting"
              ? { ...s, note: formatSettlementError(order.failureReason) }
              : s
          );
        }
      } catch {
        /* keep polling */
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stage]);

  const wrongChain =
    !!evm.account && evm.chainId != null && evm.chainId !== SWAP_CHAIN.id;

  // --- read the WBTC balance from the connected EVM wallet (for "You pay") ---
  const refreshBalance = useCallback(
    async (wbtc: string) => {
      if (!evm.account) return;
      try {
        const bal = decodeUint(
          await evm.call(wbtc, encodeBalanceOf(evm.account))
        );
        setWbtcBalance(bal);
      } catch {
        /* non-fatal */
      }
    },
    [evm]
  );

  // Proactively load the WBTC balance once the EVM wallet is connected on the
  // right chain — so the "You pay" panel shows a balance BEFORE quoting (like a
  // normal DEX). Reads the user's own balance directly via eth_call using the
  // chain's fixed WBTC address (SWAP_CHAIN.wbtc). This deliberately does NOT
  // touch the solver: your on-chain balance only needs the token + your wallet,
  // so it must keep showing even when the solver is down.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!evm.account || wrongChain || !SWAP_CHAIN.wbtc) {
        if (!cancelled) setWbtcBalance(null);
        return;
      }
      await refreshBalance(SWAP_CHAIN.wbtc);
    })();
    return () => {
      cancelled = true;
    };
  }, [evm.account, wrongChain, refreshBalance]);

  // --- CBTC auto-accept (preapproval) gate. With it ON, the delivered CBTC
  //     auto-accepts → solver finalises safely (accept-first, pay-second).
  //     Checked on the Review-swap click (the JWT session already exists by then,
  //     so NO signature). false → show the enable-auto-accept popup. ---
  const [autoAccept, setAutoAccept] = useState<boolean | null>(null);

  // --- SIGN PREREQUISITE. Before any swapping, we need a Loop JWT session (one
  //     "Exchange API Key" signature). This is a PREREQUISITE shown as our own
  //     popup on entering the swap screen — NOT something that fires on the
  //     Review-swap click. null = checking, false = needs signing (show popup),
  //     true = ready. signing = the sign action is in flight. ---
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [loopPopupBlocked, setLoopPopupBlocked] = useState(false);

  const openLoopWallet = useCallback(() => {
    const tab = openLoopWalletTab();
    if (isPopupBlocked(tab)) {
      setLoopPopupBlocked(true);
      return false;
    }
    setLoopPopupBlocked(false);
    return true;
  }, []);

  // --- ENABLE-AUTO-ACCEPT popup. Shown when Review finds preapproval OFF. The
  //     CTA first sends the user to Loop settings; on return it flips to a
  //     "confirm" CTA that re-checks the status. ---
  const [showEnablePopup, setShowEnablePopup] = useState(false);
  const [enableVisited, setEnableVisited] = useState(false); // user went to settings
  const [enableChecking, setEnableChecking] = useState(false);

  // --- SIGN PREREQUISITE: when the swap screen is open and the Loop wallet is
  //     connected, check whether we already have a valid JWT session. If yes →
  //     ready. If no → the sign popup is shown (sessionReady=false), blocking the
  //     form until the user signs. This is a pure probe (NO signature). ---
  useEffect(() => {
    let cancelled = false;
    // P2: invalidate any prior-party readiness SYNCHRONOUSLY before the async probe.
    // On a Loop-wallet switch the deps change and the probe for the NEW party is
    // async; without this, sessionReady would keep the OLD party's `true` during the
    // gap, letting actions/preapproval checks run against a stale session. Managed
    // users are set true below (no probe needed).
    if (!isParticipantManaged) setSessionReady(null);
    void (async () => {
      // Participant-managed (email) users don't have a Loop session — the backend
      // signs for them, so there's no preapproval signature to check. Mark ready.
      if (isParticipantManaged) {
        if (!cancelled) setSessionReady(true);
        return;
      }
      if (!wallet.isConnected || !wallet.provider || !wallet.partyId) {
        if (!cancelled) setSessionReady(null);
        return;
      }
      const active = await swapSessionActive(wallet.partyId);
      if (!cancelled) setSessionReady(active);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isParticipantManaged,
    wallet.isConnected,
    wallet.provider,
    wallet.partyId
  ]);

  /** Loop path: probe finished and user still needs the one-time JWT signature. */
  const needsLoopSignGate =
    loopConnected &&
    !isParticipantManaged &&
    wallet.isConnected &&
    !!wallet.provider &&
    sessionReady === false;

  // --- The explicit "Sign in your Loop wallet" action (driven by the prerequisite
  //     popup CTA). One signature → mints the JWT session → unblocks the form. ---
  const handleSign = useCallback(() => {
    if (!wallet.provider) return;
    setSignError(null);
    setLoopPopupBlocked(false);
    setSigning(true);
    void (async () => {
      try {
        const result = await mintSwapSessionDetailed(wallet.provider!);
        setSessionReady(result.ok);
        if (!result.ok) {
          setSignError(result.message);
        }
      } catch (e) {
        setSessionReady(false);
        setSignError(
          e instanceof Error
            ? e.message
            : "Something went wrong while signing. Please try again."
        );
        if (isLoopPopupBlockedError(e)) setLoopPopupBlocked(true);
      } finally {
        setSigning(false);
      }
    })();
  }, [wallet.provider]);

  /** Loop forward path only — managed (email) swaps use on-ledger HtlcLock, not Loop preapproval. */
  const probeCbtcAutoAccept = useCallback(async (): Promise<
    "ok" | "off" | "no-session" | "skipped"
  > => {
    if (isParticipantManaged || !wallet.provider) return "skipped";
    const ok = await hasCbtcAutoAccept(wallet.provider);
    setAutoAccept(ok);
    if (ok === false) return "off";
    if (ok === null) return "no-session";
    return "ok";
  }, [isParticipantManaged, wallet.provider]);

  // Loop forward: warn as soon as the JWT session is ready (not only on Review click).
  // Participant-managed users skip — their CBTC leg doesn't use Loop preapproval.
  useEffect(() => {
    if (
      isParticipantManaged ||
      isReverse ||
      isC2c ||
      !wallet.provider ||
      sessionReady !== true
    )
      return;
    let cancelled = false;
    void (async () => {
      const gate = await probeCbtcAutoAccept();
      if (cancelled || gate !== "off") return;
      setEnableVisited(false);
      setShowEnablePopup(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isParticipantManaged,
    isReverse,
    isC2c,
    wallet.provider,
    sessionReady,
    probeCbtcAutoAccept
  ]);

  /** Block the primary CTA until identity, wallets, balances, assets, and session probe finish. */
  const swapBootstrapping = useMemo(() => {
    if (!identityProbed || wallet.isLoading) return true;
    if (!identityReady) return true;
    if (!loopConnected && !process.env.NEXT_PUBLIC_SWAP_DEST_PARTY) {
      return true;
    }
    if (assetsLoading) return true;
    if (loopConnected && balanceLoading) return true;
    if (usdcxEnabled && usdcxLoading) return true;
    if (
      loopConnected &&
      !isParticipantManaged &&
      wallet.provider &&
      sessionReady === null
    ) {
      return true;
    }
    if (evm.available && !evm.hydrated) return true;
    return false;
  }, [
    identityProbed,
    wallet.isLoading,
    identityReady,
    assetsLoading,
    loopConnected,
    balanceLoading,
    usdcxEnabled,
    usdcxLoading,
    isParticipantManaged,
    wallet.provider,
    sessionReady,
    evm.available,
    evm.hydrated
  ]);

  const fail = (message: string) => setStage({ kind: "error", message });

  // --- switch wallet to the configured swap chain (adds it if unknown) ---
  const handleSwitchChain = useCallback(async () => {
    setStage({ kind: "idle" });
    try {
      await evm.switchChain(SWAP_CHAIN.id, {
        chainName: SWAP_CHAIN.name,
        rpcUrls: SWAP_CHAIN.rpcUrls,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: SWAP_CHAIN.blockExplorerUrls
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Failed to switch network.");
    }
  }, [evm]);

  // --- 1. quote (cross-chain + canton-to-canton) ---
  const handleQuote = useCallback(async () => {
    if (swapKind === "invalid-evm-evm") {
      fail("Same-chain EVM swaps aren't supported yet.");
      return;
    }
    if (swapKind === "invalid-same-asset") {
      fail("Pick two different Canton assets.");
      return;
    }
    if (swapKind === "invalid-cross-chain-canton") {
      fail("Cross-chain swaps are WBTC ↔ CBTC only.");
      return;
    }

    if (isC2c) {
      if (!destinationParty) {
        fail("Sign in to swap on Canton.");
        return;
      }
      const n = parseFloat(amount);
      if (!amount || !Number.isFinite(n) || n <= 0) {
        fail("Enter a valid amount.");
        return;
      }
      if (payLeg.chain !== "canton" || receiveLeg.chain !== "canton") {
        fail("Invalid Canton pair.");
        return;
      }
      setStage({ kind: "quoting" });
      try {
        const r = await fetch("/api/canton/swap/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromAsset: payLeg.token,
            toAsset: receiveLeg.token,
            amount,
            userParty: destinationParty
          })
        });
        const q = (await r.json()) as QuoteResponse & {
          error?: string;
          fromAsset?: string;
          toAsset?: string;
          inAmount?: string;
          grossOutAmount?: string;
          outAmount?: string;
          networkFeeCc?: string;
          networkFeeUsd?: number;
          minCcRequired?: string;
          networkFeeSource?: string;
          trafficBytes?: number;
          networkFeeCharged?: boolean;
          networkFeePreview?: boolean;
          networkFeeTransactions?: import("@/lib/canton-network-fee-math").NetworkFeeTxLeg[];
          quoteSource?: string;
          quoteAgeMs?: number;
          quoteStale?: boolean;
          midPrice?: string;
          minReceived?: string;
          minReceivedToken?: string;
          expiresAt?: number;
        };
        if (!r.ok) throw new Error(formatCantonQuoteError(q.error));
        logNetworkFeeInBrowser("c2c quote", {
          feeCc: q.networkFeeCc,
          feeUsd: q.networkFeeUsd,
          trafficBytes: q.trafficBytes,
          networkFeeSource: q.networkFeeSource,
          networkFeeCharged: q.networkFeeCharged,
          networkFeePreview: q.networkFeePreview
        });
        setStage({
          kind: "quoted",
          quote: {
            cantonParty: destinationParty,
            cbtcAmount: "0",
            wbtc: "",
            expires: q.expires,
            feeBps: q.feeBps ?? 0,
            order: q.order,
            direction: "canton-to-canton",
            fromAsset: q.fromAsset,
            toAsset: q.toAsset,
            inAmount: q.inAmount,
            grossOutAmount: q.grossOutAmount,
            outAmount: q.outAmount,
            networkFeeCc: q.networkFeeCc,
            networkFeeUsd: q.networkFeeUsd,
            minCcRequired: q.minCcRequired,
            networkFeeSource: q.networkFeeSource,
            trafficBytes: q.trafficBytes,
            networkFeeCharged: q.networkFeeCharged,
            networkFeePreview: q.networkFeePreview,
            networkFeeTransactions: q.networkFeeTransactions,
            quoteSource: q.quoteSource,
            quoteAgeMs: q.quoteAgeMs,
            quoteStale: q.quoteStale,
            midPrice: q.midPrice,
            minReceived: q.minReceived,
            minReceivedToken: q.minReceivedToken,
            expiresAt: q.expiresAt
          }
        });
      } catch (e) {
        fail(getSwapErrorMessage(e));
      }
      return;
    }

    if (!evm.account) {
      fail("Connect your EVM wallet first.");
      return;
    }
    if (!destinationParty) {
      fail(
        isReverse
          ? "Sign in to set your Canton party."
          : "Connect your Loop wallet to set the destination."
      );
      return;
    }
    let inUnits: bigint;
    try {
      inUnits = parseWbtc(amount);
    } catch {
      fail("Enter a valid amount.");
      return;
    }
    if (inUnits <= 0n) {
      fail("Amount must be greater than zero.");
      return;
    }

    if (!isParticipantManaged && sessionReady !== true) {
      setSessionReady(false);
      return;
    }

    // GATE (Loop forward only): CBTC auto-accept must be ON.
    if (!isReverse && !isParticipantManaged && wallet.provider) {
      setStage({ kind: "quoting" });
      const gate = await probeCbtcAutoAccept();
      if (gate === "off") {
        setStage({ kind: "idle" });
        setEnableVisited(false);
        setShowEnablePopup(true);
        return;
      }
      if (gate === "no-session") {
        setStage({ kind: "idle" });
        setSessionReady(false);
        return;
      }
    }

    setStage({ kind: "quoting" });
    try {
      const quote = await getQuote(
        isReverse
          ? {
              user: evm.account,
              cantonParty: destinationParty,
              cbtcAmount: inUnits.toString(),
              direction: "canton-to-evm",
              counterMode: isParticipantManaged ? "managed" : "loop"
            }
          : {
              user: evm.account,
              wbtcAmount: inUnits.toString(),
              cantonParty: destinationParty,
              direction: "evm-to-canton",
              counterMode: isParticipantManaged ? "managed" : "loop"
            }
      );
      if (!isReverse) void refreshBalance(quote.wbtc);
      logNetworkFeeInBrowser("htlc quote", {
        feeCc: quote.networkFeeCc,
        feeUsd: quote.networkFeeUsd,
        trafficBytes: quote.trafficBytes,
        minCcRequired: quote.minCcRequired,
        networkFeeSource: quote.networkFeeSource,
        networkFeeCharged: quote.networkFeeCharged,
        networkFeePreview: quote.networkFeePreview
      });
      setStage({ kind: "quoted", quote });
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        fail(
          "Swaps are paused — the WBTC/BTC price is temporarily unstable. This protects your funds; please try again shortly."
        );
        return;
      }
      fail(getSwapErrorMessage(e));
    }
  }, [
    swapKind,
    isC2c,
    payLeg,
    receiveLeg,
    evm.account,
    destinationParty,
    amount,
    isReverse,
    refreshBalance,
    wallet.provider,
    sessionReady,
    isParticipantManaged,
    probeCbtcAutoAccept
  ]);

  // --- ENABLE-AUTO-ACCEPT popup actions ---
  // CTA 1: open Loop settings in a new tab and flip the CTA to "confirm".
  const handleOpenLoopSettings = useCallback(() => {
    setEnableVisited(true);
    window.open(loopSettingsUrl(), "_blank", "noopener,noreferrer");
  }, []);

  // CTA 2 (after returning): re-check the preapproval status. ON → close popup,
  // proceed to quote. Still OFF → keep the popup with a "still off" hint.
  const handleConfirmAutoAccept = useCallback(async () => {
    if (!wallet.provider) return;
    setEnableChecking(true);
    try {
      const gate = await probeCbtcAutoAccept();
      if (gate === "ok") {
        setShowEnablePopup(false);
        void handleQuote();
      }
      if (gate === "no-session") {
        setShowEnablePopup(false);
        setSessionReady(false);
      }
    } finally {
      setEnableChecking(false);
    }
  }, [wallet.provider, probeCbtcAutoAccept, handleQuote]);

  // Begin tracking a freshly-submitted order on the dedicated swap status route.
  const startTracking = useCallback(
    (orderId: string) => {
      setStage({ kind: "redirecting", orderId });
      setAmount("");
      router.replace(`/swap/orders/${encodeURIComponent(orderId)}`);
    },
    [router]
  );

  /** Open Canton swap order created in review; cancelled on back/retry if still `open`. */
  const c2cDraftOrderIdRef = useRef<string | null>(null);
  const cancelC2cDraft = useCallback(async () => {
    const id = c2cDraftOrderIdRef.current;
    if (!id) return;
    c2cDraftOrderIdRef.current = null;
    try {
      await cantonSwapApi.cancel(id);
    } catch {
      // best-effort — may already be committed, expired, or cancelled
    }
  }, []);

  const handleC2cConfirm = useCallback(
    async (quote: QuoteResponse) => {
      const retry = (msg: string) =>
        setStage({ kind: "quoted", quote, retryError: msg });
      if (
        !destinationParty ||
        !quote.fromAsset ||
        !quote.toAsset ||
        !quote.outAmount
      ) {
        retry("Invalid quote — try again.");
        return;
      }
      const fromAsset = quote.fromAsset as "CBTC" | "CC";
      const toAsset = quote.toAsset as "CBTC" | "CC";
      const walletMode = isParticipantManaged ? "managed" : "loop";
      const inAmount = quote.inAmount ?? amount;

      if (walletMode === "managed") {
        if (needsCcDeposit) {
          retry(
            `Deposit at least ${managedPreapproval?.ccMinToEnable ?? 2} CC on your Canton party first.`
          );
          return;
        }
        if (needsEnableCc || needsEnableCbtc) {
          retry("Complete one-time auto-accept setup before swapping.");
          return;
        }
        if (managedPreapproval?.swap && !managedPreapproval.swap.ready) {
          retry(
            managedPreapproval.swap.issues?.join(" ") ??
              "Atomic swap requires preapproval on both parties."
          );
          return;
        }
        if (
          quote.networkFeeCharged &&
          quote.networkFeeSource &&
          quote.networkFeeSource !== "disabled" &&
          quote.minCcRequired &&
          managedPreapproval?.ccTotal != null &&
          Number.parseFloat(managedPreapproval.ccTotal) <
            Number.parseFloat(quote.minCcRequired)
        ) {
          retry(
            `Need ${quote.minCcRequired} CC for network fee + reserve (you have ${managedPreapproval.ccTotal} CC). Send CC from Account → Send.`
          );
          return;
        }
      }

      try {
        setStage({ kind: "submitting", quote, c2cPhase: "sign" });
        await cancelC2cDraft();

        if (walletMode === "managed") {
          const { order } = await cantonSwapApi.submitManaged({
            fromAsset,
            toAsset,
            inAmount,
            outAmount: quote.outAmount,
            userParty: destinationParty
          });
          startTracking(order.id);
          return;
        }

        const provider = wallet.provider;
        if (!provider) {
          retry("Connect Loop wallet first.");
          return;
        }
        const loopParty =
          (provider as { party_id?: string }).party_id ?? wallet.partyId ?? "";
        if (!loopParty) {
          retry("Loop wallet party unavailable — reconnect and try again.");
          return;
        }
        if (loopParty !== destinationParty) {
          retry(
            "Loop wallet party does not match swap account — reconnect Loop."
          );
          return;
        }
        const holdingCids =
          fromAsset === "CBTC"
            ? await listLoopCbtcHoldingCids(provider)
            : await listLoopInstrumentHoldingCids(provider, {
                admin: "",
                id: "Amulet"
              });
        if (holdingCids.length === 0) {
          retry(`No unlocked ${fromAsset} in Loop wallet.`);
          return;
        }
        const c2cQuoteKey = {
          fromAsset,
          toAsset,
          inAmount,
          outAmount: quote.outAmount,
          userParty: destinationParty
        };
        const pendingC2c = readPendingLoopCommit();
        if (
          pendingC2c?.flow === "c2c" &&
          pendingC2cMatchesQuote(pendingC2c, c2cQuoteKey) &&
          pendingC2c.submitUpdateId
        ) {
          await cantonSwapApi.commitUserLeg({
            ...c2cQuoteKey,
            orderId: pendingC2c.orderId,
            createdAt: pendingC2c.createdAt,
            submitUpdateId: pendingC2c.submitUpdateId
          });
          clearPendingLoopCommit(pendingC2c.orderId);
          startTracking(pendingC2c.orderId);
          return;
        }
        const prep = await cantonSwapApi.prepareUserLegIntent({
          ...c2cQuoteKey,
          inputHoldingCids: holdingCids,
          orderId:
            pendingC2c?.flow === "c2c" &&
            pendingC2cMatchesQuote(pendingC2c, c2cQuoteKey)
              ? pendingC2c.orderId
              : undefined
        });
        const orderId = prep.orderId;
        const legCreatedAt = prep.createdAt;
        writePendingLoopCommit({
          flow: "c2c",
          orderId,
          createdAt: legCreatedAt,
          ...c2cQuoteKey
        });
        setStage({ kind: "submitting", quote, c2cPhase: "confirm" });
        const submitResult = await provider.submitAndWaitForTransaction({
          commands: [prep.command],
          disclosedContracts: prep.disclosedContracts,
          packageIdSelectionPreference: [],
          actAs: [loopParty],
          readAs: [loopParty],
          synchronizerId: prep.synchronizerId
        });
        const submitUpdateId = extractSubmitUpdateId(submitResult);
        if (!submitUpdateId) {
          retry("Loop did not return a ledger update id — try again.");
          return;
        }
        patchPendingLoopCommit({
          flow: "c2c",
          submitUpdateId
        });
        await cantonSwapApi.commitUserLeg({
          ...c2cQuoteKey,
          orderId,
          createdAt: legCreatedAt,
          submitUpdateId
        });
        clearPendingLoopCommit(orderId);
        startTracking(orderId);
      } catch (e) {
        if (isLoopPopupBlockedError(e)) setLoopPopupBlocked(true);
        const msg = getSwapErrorMessage(e);
        retry(msg || "Could not submit swap.");
      }
    },
    [
      destinationParty,
      amount,
      isParticipantManaged,
      wallet.provider,
      wallet.partyId,
      needsCcDeposit,
      needsEnableCc,
      needsEnableCbtc,
      managedPreapproval,
      cancelC2cDraft,
      startTracking
    ]
  );

  // --- 2. approve (if needed) + 3. sign + 4. submit ---
  // Recoverable failures (rejected approve/sign, transient submit) return to the
  // `quoted` stage with a retryError so the user can retry WITHOUT re-quoting.
  const handleConfirm = useCallback(
    async (quote: QuoteResponse) => {
      if (quote.direction === "canton-to-canton") {
        await handleC2cConfirm(quote);
        return;
      }
      const retry = (msg: string) =>
        setStage({ kind: "quoted", quote, retryError: msg });
      if (!evm.account) {
        retry("Wallet disconnected — reconnect and try again.");
        return;
      }
      if (!SOLVER_CANTON) {
        retry(
          "Settlement vault not configured (NEXT_PUBLIC_CANTON_SWAP_SETTLEMENT_PARTY)."
        );
        return;
      }
      const wbtcUnits = BigInt(quote.order.inputs[0][1]);
      const cbtcUnits = BigInt(quote.order.outputs[0].amount);
      const cbtcAmount = (Number(cbtcUnits) / 1e8).toFixed(8); // CBTC decimal string

      const now = Math.floor(Date.now() / 1000);
      const { userTimelock, solverTimelock } = timelocksFromExpiration(
        now,
        expirationSeconds
      );
      const counterMode: "managed" | "loop" = isParticipantManaged
        ? "managed"
        : "loop";
      const forwardQuoteKey = {
        userCantonParty: quote.cantonParty,
        userEvmAddress: evm.account,
        wbtcAmount: wbtcUnits.toString(),
        cbtcAmount,
        userTimelock,
        solverTimelock,
        counterMode
      };
      const pendingForward = readPendingLoopCommit();
      let secret: string;
      let hashLock: string;
      let id: string;
      const forwardVaultMeta = {
        direction: "evm-to-canton" as const,
        counterMode,
        userCantonParty: quote.cantonParty,
        userEvmAddress: evm.account,
        userTimelock,
        solverTimelock
      };
      if (
        pendingForward?.flow === "forward-htlc" &&
        pendingForwardMatchesQuote(pendingForward, forwardQuoteKey)
      ) {
        hashLock = pendingForward.hashLock;
        id = hashLock;
        secret = await recallHtlcConfirmSecret(
          id,
          forwardVaultMeta,
          await vaultRecallContext()
        );
      } else {
        ({ secret, hashLock } = generateSecret());
        id = hashLock;
      }
      const resumedForward =
        pendingForward?.flow === "forward-htlc" &&
        pendingForwardMatchesQuote(pendingForward, forwardQuoteKey);
      const orderInput = {
        id,
        direction: "evm-to-canton" as const,
        hashLock,
        userEvmAddress: evm.account,
        solverEvmAddress: SOLVER_EVM,
        wbtcAmount: wbtcUnits.toString(),
        userTimelock,
        userCantonParty: quote.cantonParty,
        solverCantonParty: SOLVER_CANTON,
        cbtcAmount,
        solverTimelock,
        counterMode
      };

      let lockTx = "";
      try {
        await ensureSwapSecret(id, secret, forwardVaultMeta);
        if (!resumedForward) {
          writePendingLoopCommit({
            flow: "forward-htlc",
            hashLock,
            ...forwardQuoteKey
          });
        }
        setStage({ kind: "submitting", quote });
        if (
          !(
            pendingForward?.flow === "forward-htlc" &&
            pendingForwardMatchesQuote(pendingForward, forwardQuoteKey) &&
            pendingForward.prepared
          )
        ) {
          await htlcApi.prepareForwardIntent(orderInput);
          patchPendingLoopCommit({ flow: "forward-htlc", prepared: true });
        }
        setStage({ kind: "approving", quote });
        const wbtcToken = SWAP_CHAIN.wbtc || quote.wbtc;
        lockTx = await evmApproveAndLock(
          evm.sendTransaction,
          evm.call,
          evm.account,
          {
            wbtc: wbtcToken,
            escrow: HTLC_ESCROW,
            amount: wbtcUnits,
            hashLock,
            unlockTime: userTimelock,
            receiver: SOLVER_EVM
          }
        );
        activeMainLockRecordingRef.current = id;
        setStage({
          kind: "htlc-recording",
          swapId: id,
          lockTx,
          userCantonParty: quote.cantonParty,
          userEvmAddress: evm.account.toLowerCase(),
          waitStartedAt: Date.now()
        });
        rememberPendingMainLock({
          swapId: id,
          lockTx,
          userCantonParty: quote.cantonParty,
          userEvmAddress: evm.account,
          expiresAt: userTimelock + 3600,
          wbtcAmount: orderInput.wbtcAmount,
          cbtcAmount: orderInput.cbtcAmount,
          userTimelock: orderInput.userTimelock,
          solverTimelock: orderInput.solverTimelock,
          counterMode: orderInput.counterMode
        });
        try {
          await evm.waitForReceipt(lockTx);
          await htlcApi.commitForward({ ...orderInput, mainLockTx: lockTx });
          clearPendingLoopCommit(id);
          forgetPendingMainLock(id);
        } finally {
          if (activeMainLockRecordingRef.current === id) {
            activeMainLockRecordingRef.current = null;
          }
        }
      } catch (e) {
        // P1a: once evmApproveAndLock returned a tx hash, the WBTC lock may have been
        // (or may still get) mined — DO NOT retry() into a fresh order/hash, which
        // strands the locked WBTC on an order with no mainLockTx (hidden by
        // isAbandonedSwapDraft + ignored by the daemon).
        const submitted = typeof lockTx === "string" && lockTx.length > 0;
        // A REVERT means the lock did NOT take effect — nothing is locked, so a clean
        // reset to quote is correct.
        const reverted = e instanceof EvmTxRevertedError;
        if (submitted && !reverted && !isUserRejection(e)) {
          // The durable pending-lock record survives refresh/restart. The recovery
          // effect below waits for a successful receipt and retries the idempotent
          // server write until it is acknowledged.
          setStage({
            kind: "htlc-locking",
            quote,
            swapId: id,
            secret,
            lockTx,
            userCantonParty: quote.cantonParty,
            userEvmAddress: evm.account.toLowerCase(),
            waitStartedAt: Date.now(),
            recordingRecovery: true
          });
          return;
        }
        if (reverted) forgetPendingMainLock(id);
        if (
          e instanceof Error &&
          e.message === HTLC_VAULT_FAIL_MSG &&
          !resumedForward
        ) {
          clearPendingLoopCommit(id);
        }
        retry(
          isUserRejection(e)
            ? "Lock cancelled. Approve + lock your WBTC to start the swap."
            : getSwapErrorMessage(e)
        );
        return;
      }

      // 4. WAIT for the INDEPENDENT SOLVER on the dedicated status route.
      startTracking(id);
    },
    [
      evm,
      expirationSeconds,
      isParticipantManaged,
      ensureSwapSecret,
      handleC2cConfirm,
      startTracking,
      vaultRecallContext
    ]
  );

  // THE USER's CLAIM (the real reveal) — signed by the USER's Loop wallet.
  // HtlcLock.Claim is controller=receiver, so it MUST be submitted by the user's
  // own wallet (their participant supplies the receiver authority; Preapproval
  // auto-accepts the CBTC delivery). The backend only PREPARES the command. Then
  // the solver daemon reads the now-public preimage and claims the WBTC on EVM.
  const handleClaim = useCallback(
    async (swapId: string, secret: string, lockTx: string) => {
      setStage({ kind: "htlc-claiming", swapId, secret, lockTx });
      try {
        const preimage = secretToPreimage(secret);

        // Branch on the ORDER's counterMode (set authoritatively server-side from
        // the receiver party's namespace) — NOT the UI's isParticipantManaged, which
        // can be a stale closure from before the session probe resolved.
        const { order: claimOrder } = await htlcApi.getOrder(swapId);
        const doneAmounts = claimOrder as
          | { wbtcAmount?: string; cbtcAmount?: string }
          | undefined;
        const mode =
          (claimOrder as { counterMode?: string } | undefined)?.counterMode ??
          (isParticipantManaged ? "managed" : "loop");

        if (mode === "managed") {
          // PARTICIPANT-MANAGED: the backend signs HtlcLock.Claim AS the hosted
          // receiver (CanActAs). One call, no wallet popup. The daemon then claims
          // the WBTC from the revealed preimage.
          await htlcApi.claimManaged(swapId, preimage);
          forgetSecret(swapId);
          setStage({
            kind: "htlc-done",
            swapId,
            lockTx,
            wbtcAmount: doneAmounts?.wbtcAmount,
            cbtcAmount: doneAmounts?.cbtcAmount
          });
          return;
        }

        // LOOP path (Loop's Option 1, custody ordering like Cancore's venue flow):
        // 1. REVEAL FIRST — send the secret to our node. The backend verifies the
        //    preimage AND the real on-chain WBTC lock, then delivers the CBTC via a
        //    standard transfer. (Secret-before-delivery = the solver can always claim
        //    the WBTC; delivery-before-secret would let a user rob the solver.)
        // 2. The user signs a STANDARD TransferInstruction_Accept in their wallet —
        //    a built-in Splice choice on Loop's node (NO custom DAR).
        const provider = wallet.provider;
        if (!provider)
          throw new Error("Connect your Loop wallet to accept your CBTC.");
        await claimSwap({
          order: {
            id: swapId,
            direction: "evm-to-canton",
            counterMode: "loop"
          },
          secret,
          escrow: HTLC_ESCROW,
          loop: provider as unknown as {
            party_id?: string;
            submitAndWaitForTransaction: (
              payload: unknown,
              options?: unknown
            ) => Promise<unknown>;
          }
        });
        forgetSecret(swapId);
        setStage({
          kind: "htlc-done",
          swapId,
          lockTx,
          wbtcAmount: doneAmounts?.wbtcAmount,
          cbtcAmount: doneAmounts?.cbtcAmount
        });
        return;
      } catch (e) {
        setStage({
          kind: "htlc-claimable",
          swapId,
          secret,
          lockTx,
          claimError: getSwapErrorMessage(e)
        });
      }
    },
    [wallet, isParticipantManaged]
  );

  // --- 2b. confirm reverse (canton-to-evm) — same review modal as forward ---
  const handleConfirmReverse = useCallback(
    async (quote: QuoteResponse) => {
      const retry = (msg: string) =>
        setStage({ kind: "quoted", quote, retryError: msg });
      if (!evm.account || !destinationParty || !SOLVER_CANTON) {
        retry("Wallet or party disconnected — reconnect and try again.");
        return;
      }
      const cbtcUnits = BigInt(quote.cbtcAmount);
      const wbtcUnits = BigInt(
        quote.wbtcAmount ?? quote.order.outputs[0]?.amount ?? "0"
      );
      if (wbtcUnits <= 0n || cbtcUnits <= 0n) {
        retry("Invalid quote — please review again.");
        return;
      }
      const cbtcAmount = (Number(cbtcUnits) / 1e8).toFixed(8);
      const wbtcAmount = wbtcUnits.toString();
      const now = Math.floor(Date.now() / 1000);
      const { userTimelock, solverTimelock } = timelocksFromExpiration(
        now,
        expirationSeconds
      );
      const counterMode: "managed" | "loop" = isParticipantManaged
        ? "managed"
        : "loop";
      const reverseQuoteKey = {
        cbtcAmount,
        wbtcAmount,
        userCantonParty: destinationParty,
        userEvmAddress: evm.account,
        userTimelock,
        solverTimelock
      };
      const pendingReverse = readPendingLoopCommit();
      let secret: string;
      let hashLock: string;
      let id: string;
      const reverseVaultMeta = {
        direction: "canton-to-evm" as const,
        counterMode,
        userCantonParty: destinationParty,
        userEvmAddress: evm.account,
        userTimelock,
        solverTimelock
      };
      if (
        pendingReverse?.flow === "reverse-htlc" &&
        pendingReverseMatchesQuote(pendingReverse, reverseQuoteKey, wbtcAmount)
      ) {
        hashLock = pendingReverse.hashLock;
        id = hashLock;
        secret = await recallHtlcConfirmSecret(
          id,
          reverseVaultMeta,
          await vaultRecallContext()
        );
      } else {
        ({ secret, hashLock } = generateSecret());
        id = hashLock;
      }
      const resumedReverse =
        pendingReverse?.flow === "reverse-htlc" &&
        pendingReverseMatchesQuote(pendingReverse, reverseQuoteKey, wbtcAmount);
      const orderInput = {
        id,
        direction: "canton-to-evm" as const,
        hashLock,
        userEvmAddress: evm.account,
        solverEvmAddress: SOLVER_EVM,
        wbtcAmount,
        userTimelock,
        userCantonParty: destinationParty,
        solverCantonParty: SOLVER_CANTON,
        cbtcAmount,
        solverTimelock,
        counterMode
      };

      try {
        await ensureSwapSecret(id, secret, reverseVaultMeta);
        if (!resumedReverse) {
          writePendingLoopCommit({
            flow: "reverse-htlc",
            hashLock,
            ...reverseQuoteKey
          });
        }
        setStage({ kind: "submitting", quote });
        if (counterMode === "managed") {
          setStage({ kind: "redirecting", orderId: id });
          setAmount("");
          await htlcApi.commitReverseManaged(orderInput);
          clearPendingLoopCommit(id);
          startTracking(id);
          return;
        }

        if (
          pendingReverse?.flow === "reverse-htlc" &&
          pendingReverseMatchesQuote(pendingReverse, reverseQuoteKey, wbtcAmount) &&
          pendingReverse.submitUpdateId &&
          pendingReverse.createdAt
        ) {
          await htlcApi.commitReverseLoop({
            ...orderInput,
            createdAt: pendingReverse.createdAt,
            submitUpdateId: pendingReverse.submitUpdateId,
            offerCidHint: pendingReverse.offerCidHint
          });
          clearPendingLoopCommit(id);
          startTracking(id);
          return;
        }

        const provider = wallet.provider;
        if (!provider)
          throw new Error("Connect your Loop wallet to lock your CBTC.");
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
        const prep = await htlcApi.prepareLockIntent({
          ...orderInput,
          holdingCids
        });
        patchPendingLoopCommit({
          flow: "reverse-htlc",
          createdAt: prep.createdAt
        });
        const userParty =
          (provider as { party_id?: string }).party_id ??
          wallet.partyId ??
          "";
        const submitResult = await provider.submitAndWaitForTransaction(
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
        const submitUpdateId = extractSubmitUpdateId(submitResult);
        if (!submitUpdateId) {
          throw new Error(
            "Loop did not return a ledger update id — open Loop and try again."
          );
        }
        const offerCidHint = extractLoopSubmitOfferCid(submitResult) ?? undefined;
        patchPendingLoopCommit({
          flow: "reverse-htlc",
          submitUpdateId,
          offerCidHint
        });
        await htlcApi.commitReverseLoop({
          ...orderInput,
          createdAt: prep.createdAt,
          submitUpdateId,
          offerCidHint
        });
        clearPendingLoopCommit(id);
        startTracking(id);
      } catch (e) {
        if (isLoopPopupBlockedError(e)) setLoopPopupBlocked(true);
        if (counterMode === "loop") {
          try {
            const { order } = await htlcApi.getOrder(id);
            if (order.status === "main_locked") {
              clearPendingLoopCommit(id);
              startTracking(id);
              return;
            }
            if (needsHtlcLoopLockConfirm(order)) {
              await htlcApi.confirmLockLoop(id);
              clearPendingLoopCommit(id);
              startTracking(id);
              return;
            }
          } catch {
            /* fall through to user-facing error */
          }
        }
        if (
          e instanceof Error &&
          e.message === HTLC_VAULT_FAIL_MSG &&
          !resumedReverse
        ) {
          clearPendingLoopCommit(id);
        }
        retry(
          (() => {
            const msg = getSwapErrorMessage(e);
            if (
              counterMode === "loop" &&
              msg === "You declined the request in your wallet."
            ) {
              return "Loop may have approved your CBTC lock, but WarpX did not finish linking it. Keep this tab open and click Try again, or finish from Orders.";
            }
            return msg || "Could not submit swap.";
          })()
        );
      }
    },
    [
      evm.account,
      destinationParty,
      expirationSeconds,
      isParticipantManaged,
      wallet,
      ensureSwapSecret,
      startTracking,
      vaultRecallContext
    ]
  );

  // REVERSE claim — the user claims the WBTC in MetaMask. This on-chain
  // claim(preimage) IS the secret reveal; the daemon then claims the CBTC.
  const handleClaimReverse = useCallback(
    async (
      swapId: string,
      secret: string,
      preflight?: {
        hashLock?: string;
        wbtcAmount?: string;
        userEvmAddress?: string;
        cbtcAmount?: string;
      }
    ) => {
      setStage({ kind: "rev-claiming", swapId, secret });
      try {
        let hashLock = preflight?.hashLock ?? swapId;
        let wbtcAmount = preflight?.wbtcAmount;
        let userEvmAddress = preflight?.userEvmAddress ?? evm.account ?? "";
        let cbtcAmount = preflight?.cbtcAmount;

        if (!wbtcAmount) {
          const { order } = await htlcApi.getOrder(swapId);
          const o = order as {
            hashLock?: string;
            wbtcAmount?: string;
            userEvmAddress?: string;
            cbtcAmount?: string;
          } | null;
          hashLock = o?.hashLock ?? hashLock;
          wbtcAmount = o?.wbtcAmount ?? "0";
          userEvmAddress = o?.userEvmAddress ?? userEvmAddress;
          cbtcAmount = o?.cbtcAmount ?? cbtcAmount;
        }

        const probe = await isReverseEvmCounterLockReady({
          hashLock,
          wbtcAmount: wbtcAmount ?? "0",
          userEvmAddress
        });
        if (!probe.ready) {
          throw new Error(probe.reason);
        }
        const preimage = secretToPreimage(secret);
        const tx = await evmClaim(evm.sendTransaction, HTLC_ESCROW, preimage);
        // Wait for the claim to be MINED before recording — the API verifies the
        // on-chain receipt, which won't exist if we record the pending hash.
        await evm.waitForReceipt(tx);
        await htlcApi.recordClaim(swapId, preimage, tx);
        forgetSecret(swapId);
        setStage({
          kind: "rev-done",
          swapId,
          claimTx: tx,
          wbtcAmount,
          cbtcAmount,
          settling: true
        });
      } catch (e) {
        const msg = getSwapErrorMessage(e);
        const { order } = await htlcApi.getOrder(swapId).catch(() => ({
          order: null
        }));
        const o = order as {
          hashLock?: string;
          wbtcAmount?: string;
          userEvmAddress?: string;
          cbtcAmount?: string;
          status?: string;
          mainClaimTx?: string;
          direction?: "canton-to-evm";
        } | null;
        if (
          o?.status === "main_claimed" ||
          (o?.status === "counter_claimed" && o?.mainClaimTx)
        ) {
          forgetSecret(swapId);
          const projected = projectHtlcStatus(
            o as Parameters<typeof projectHtlcStatus>[0]
          );
          setStage({
            kind: "rev-done",
            swapId,
            claimTx: o.mainClaimTx ?? "",
            wbtcAmount: o.wbtcAmount ?? preflight?.wbtcAmount,
            cbtcAmount: o.cbtcAmount ?? preflight?.cbtcAmount,
            settling: !projected.proofComplete
          });
          return;
        }
        const probe =
          o?.wbtcAmount && o?.userEvmAddress
            ? await isReverseEvmCounterLockReady({
                hashLock: o.hashLock ?? swapId,
                wbtcAmount: o.wbtcAmount,
                userEvmAddress: o.userEvmAddress
              }).catch(() => ({ ready: false as const, reason: msg }))
            : { ready: false as const, reason: msg };
        if (!probe.ready && o?.status === "main_locked") {
          startTracking(swapId);
          return;
        }
        setStage({
          kind: "rev-claimable",
          swapId,
          secret,
          claimError: msg,
          hashLock: o?.hashLock ?? preflight?.hashLock ?? swapId,
          wbtcAmount: o?.wbtcAmount ?? preflight?.wbtcAmount,
          userEvmAddress: o?.userEvmAddress ?? preflight?.userEvmAddress,
          cbtcAmount: o?.cbtcAmount ?? preflight?.cbtcAmount
        });
      }
    },
    [evm, startTracking]
  );

  // RETAKE (EVM refund) — if a swap is stuck, the user reclaims their locked WBTC
  // by signing retake(hashLock) in MetaMask. Only succeeds after the EVM timelock
  // (the contract enforces TooEarly otherwise). swapId === hashLock.
  const handleRetake = useCallback(
    async (swapId: string) => {
      try {
        const tx = await evmRetake(evm.sendTransaction, HTLC_ESCROW, swapId);
        // Wait for the retake to be MINED before recording (the API verifies the
        // on-chain Retaken receipt).
        await evm.waitForReceipt(tx);
        await htlcApi.recordRetake(swapId, tx);
        forgetSecret(swapId);
        setStage({ kind: "htlc-refunded", swapId, retakeTx: tx });
      } catch (e) {
        setStage((s) =>
          s.kind === "htlc-claimable"
            ? { ...s, claimError: `Retake failed: ${getSwapErrorMessage(e)}` }
            : s
        );
      }
    },
    [evm]
  );

  // Recover a submitted EVM lock whose receipt/API acknowledgement raced a timeout.
  // The pending record is non-secret localStorage state, so this continues across a
  // page reload or browser restart. The API independently verifies the escrow state
  // and is idempotent for the same tx hash.
  const pendingLockRecoveryInFlightRef = useRef(false);
  useEffect(() => {
    let cancelled = false;

    const recover = async () => {
      if (pendingLockRecoveryInFlightRef.current) return;
      const recoveryIdentityReady =
        !!process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ||
        (identityProbed && !wallet.isLoading);
      if (
        !recoveryIdentityReady ||
        !destinationParty ||
        !evm.hydrated ||
        !evm.account
      ) {
        return;
      }
      const recoveryEvmAddress = evm.account.trim().toLowerCase();

      const stagePending =
        stage.kind === "htlc-locking" &&
        stage.recordingRecovery &&
        stage.userCantonParty === destinationParty &&
        stage.userEvmAddress === recoveryEvmAddress
          ? {
              swapId: stage.swapId,
              lockTx: stage.lockTx,
              userCantonParty: stage.userCantonParty,
              userEvmAddress: stage.userEvmAddress
            }
          : stage.kind === "htlc-recording" &&
              stage.userCantonParty === destinationParty &&
              stage.userEvmAddress === recoveryEvmAddress
            ? {
                swapId: stage.swapId,
                lockTx: stage.lockTx,
                userCantonParty: stage.userCantonParty,
                userEvmAddress: stage.userEvmAddress
              }
            : null;
      const activeId = readActiveHtlcSwap();
      const storedPending = selectPendingMainLock(readPendingMainLocks(), {
        userCantonParty: destinationParty,
        userEvmAddress: recoveryEvmAddress,
        activeSwapId: activeId
      });
      const pending = stagePending ?? storedPending;
      if (!pending) return;
      if (activeMainLockRecordingRef.current === pending.swapId) return;

      pendingLockRecoveryInFlightRef.current = true;
      if (
        stage.kind !== "htlc-locking" &&
        stage.kind !== "htlc-recording"
      ) {
        setStage({
          kind: "htlc-recording",
          swapId: pending.swapId,
          lockTx: pending.lockTx,
          userCantonParty: pending.userCantonParty,
          userEvmAddress: pending.userEvmAddress,
          waitStartedAt:
            "createdAt" in pending && typeof pending.createdAt === "number"
              ? pending.createdAt
              : Date.now()
        });
      }

      try {
        const provider = getBrowserEvmProvider();
        if (provider) {
          const receipt = await getEvmReceiptState(provider, pending.lockTx);
          if (receipt === "reverted") {
            forgetPendingMainLock(pending.swapId);
            forgetSecret(pending.swapId);
            if (!cancelled) {
              setStage({
                kind: "error",
                message:
                  "The submitted WBTC lock reverted on-chain, so no funds were locked. Start a new swap."
              });
            }
            return;
          }
        }

        // The configured-chain server check is authoritative. While the tx is
        // pending this fails closed; the interval retries until the lock is visible.
        const stored = pending as PendingMainLock;
        const recovered =
          stored.wbtcAmount &&
          stored.cbtcAmount &&
          stored.userTimelock &&
          stored.solverTimelock
            ? ((await htlcApi.commitForward({
                id: stored.swapId,
                direction: "evm-to-canton",
                hashLock: stored.swapId,
                userEvmAddress: stored.userEvmAddress,
                solverEvmAddress: SOLVER_EVM,
                wbtcAmount: stored.wbtcAmount,
                userTimelock: stored.userTimelock,
                userCantonParty: stored.userCantonParty,
                solverCantonParty: SOLVER_CANTON,
                cbtcAmount: stored.cbtcAmount,
                solverTimelock: stored.solverTimelock,
                counterMode: stored.counterMode ?? "loop",
                mainLockTx: stored.lockTx
              })) as {
                order?: {
                  status?: string;
                  wbtcAmount?: string;
                  cbtcAmount?: string;
                };
              })
            : ((await htlcApi.recordMainLock(
                pending.swapId,
                pending.lockTx
              )) as {
                order?: {
                  status?: string;
                  wbtcAmount?: string;
                  cbtcAmount?: string;
                };
              });
        forgetPendingMainLock(pending.swapId);
        if (!cancelled) {
          const recoveredStatus = recovered.order?.status;
          if (
            recoveredStatus === "main_claimed" ||
            recoveredStatus === "both_claimed" ||
            recoveredStatus === "refunded" ||
            recoveredStatus === "cancelled" ||
            recoveredStatus === "failed"
          ) {
            forgetSecret(pending.swapId);
          }
          router.push(`/swap/orders/${encodeURIComponent(pending.swapId)}`);
        }
      } catch {
        // Keep retrying silently. The stage itself already says the lock is being
        // confirmed; surfacing this transient API race made healthy swaps look broken.
      } finally {
        pendingLockRecoveryInFlightRef.current = false;
      }
    };

    void recover();
    const timer = setInterval(() => void recover(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    destinationParty,
    evm.account,
    evm.hydrated,
    identityProbed,
    router,
    stage,
    wallet.isLoading
  ]);

  // A wallet switch must not leave another party's recovery screen blocking this
  // wallet. The durable record remains and resumes when the originating wallet
  // reconnects.
  useEffect(() => {
    if (
      (stage.kind === "htlc-recording" ||
        (stage.kind === "htlc-locking" && !!stage.recordingRecovery)) &&
      ((destinationParty && stage.userCantonParty !== destinationParty) ||
        (evm.account &&
          stage.userEvmAddress !== evm.account.trim().toLowerCase()))
    ) {
      setStage({ kind: "idle" });
    }
  }, [destinationParty, evm.account, stage]);

  // Legacy active-swap marker: do not resurrect a status screen on /swap.
  // Submitted orders now live under /swap/orders/:id. Pending EVM-lock recovery
  // above is the only /swap-side resume path because it protects a submitted
  // lock before the server has acknowledged it.
  const resumeCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    const swapId = readActiveHtlcSwap();
    if (!swapId || resumeCheckedRef.current === swapId) return;
    resumeCheckedRef.current = swapId;
  }, [stage.kind]);

  const unlockResumeSecret = useCallback(
    async (
      swapId: string,
      lockTx: string,
      direction: "evm-to-canton" | "canton-to-evm"
    ) => {
      const unlockFailMsg =
        "Could not unlock the saved secret. Connect the same wallet/account or paste it from Orders.";
      try {
        const { order } = await htlcApi.getOrder(swapId);
        const o = order as {
          direction?: "evm-to-canton" | "canton-to-evm";
          counterMode?: "managed" | "loop";
          userCantonParty?: string;
          userEvmAddress?: string;
          userTimelock?: number;
          solverTimelock?: number;
          mainLockTx?: string;
        } | null;
        const orderMeta =
          vaultMetaFromOrder({
            direction: o?.direction ?? direction,
            counterMode: o?.counterMode,
            userCantonParty: o?.userCantonParty,
            userEvmAddress: o?.userEvmAddress,
            userTimelock: o?.userTimelock,
            solverTimelock: o?.solverTimelock
          }) ?? undefined;
        const secret = await resolveHtlcClaimSecret(swapId, swapId, {
          ctx: await vaultRecallContext(),
          orderMeta
        });
        if (!secret) {
          if (direction === "canton-to-evm") {
            setStage({
              kind: "rev-resume",
              swapId,
              unlockError: unlockFailMsg
            });
          } else {
            setStage({
              kind: "htlc-resume",
              swapId,
              lockTx,
              unlockError: unlockFailMsg
            });
          }
          return;
        }
        if (direction === "canton-to-evm") {
          const { order: ord } = await htlcApi.getOrder(swapId).catch(() => ({
            order: null
          }));
          const meta = ord as {
            hashLock?: string;
            wbtcAmount?: string;
            userEvmAddress?: string;
          } | null;
          const probe =
            meta?.wbtcAmount && meta?.userEvmAddress
              ? await isReverseEvmCounterLockReady({
                  hashLock: meta.hashLock ?? swapId,
                  wbtcAmount: meta.wbtcAmount,
                  userEvmAddress: meta.userEvmAddress
                })
              : { ready: false as const, reason: "Missing order fields." };
          if (!probe.ready) {
            startTracking(swapId);
            return;
          }
          setStage({
            kind: "rev-claimable",
            swapId,
            secret,
            hashLock: meta?.hashLock ?? swapId,
            wbtcAmount: meta?.wbtcAmount,
            userEvmAddress: meta?.userEvmAddress,
            cbtcAmount: (ord as { cbtcAmount?: string } | null)?.cbtcAmount
          });
        } else {
          setStage({
            kind: "htlc-claimable",
            swapId,
            secret,
            lockTx: lockTx || o?.mainLockTx || ""
          });
        }
      } catch (e) {
        const unlockError = getSwapErrorMessage(e);
        if (direction === "canton-to-evm") {
          setStage({ kind: "rev-resume", swapId, unlockError });
        } else {
          setStage({ kind: "htlc-resume", swapId, lockTx, unlockError });
        }
      }
    },
    [vaultRecallContext, startTracking]
  );

  // NOTE: the CBTC accept is detected AUTOMATICALLY by the solver (accept-watch
  // advances delivering→delivered on its own once the auto-accept lands), so the
  // UI no longer needs a manual "confirm delivery" step. The mandatory auto-accept
  // gate guarantees the accept fires without user action.

  const reset = useCallback(() => {
    void cancelC2cDraft();
    setAmount("");
    setStage({ kind: "idle" });
  }, [cancelC2cDraft]);

  const dismissToNewSwap = useCallback(
    (swapId?: string) => {
      dismissActiveHtlcSwap(swapId);
      void cancelC2cDraft();
      setAmount("");
      setStage({ kind: "idle" });
    },
    [cancelC2cDraft]
  );

  const [waitNowMs, setWaitNowMs] = useState(() => Date.now());
  const waitStartedAt = useMemo(() => {
    if (stage.kind === "htlc-locking") return stage.waitStartedAt;
    if (stage.kind === "htlc-recording") return stage.waitStartedAt;
    if (
      stage.kind === "rev-locking" &&
      (stage.phase === "solver" || stage.phase === "custody")
    )
      return stage.waitStartedAt;
    if (stage.kind === "c2c-waiting") return stage.waitStartedAt;
    return undefined;
  }, [stage]);
  useEffect(() => {
    if (!waitStartedAt) return;
    setWaitNowMs(Date.now());
    const t = setInterval(() => setWaitNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waitStartedAt]);
  const waitElapsedSec = waitStartedAt
    ? Math.max(0, Math.floor((waitNowMs - waitStartedAt) / 1000))
    : 0;

  const htlcSolverWait = useMemo(() => {
    if (stage.kind === "htlc-locking") {
      return {
        swapId: stage.swapId,
        mode: "forward" as const,
        secret: stage.secret,
        lockTx: stage.lockTx
      };
    }
    if (stage.kind === "rev-locking" && stage.phase === "solver") {
      return {
        swapId: stage.swapId,
        mode: "reverse" as const,
        secret: stage.secret,
        waitStartedAt: stage.waitStartedAt
      };
    }
    if (stage.kind === "rev-done" && stage.settling) {
      return {
        swapId: stage.swapId,
        mode: "reverse" as const,
        secret: "",
        settling: true as const
      };
    }
    return null;
  }, [stage]);

  const htlcPollInFlightRef = useRef(false);

  useEffect(() => {
    if (!htlcSolverWait) return;
    let cancelled = false;
    const poll = async () => {
      if (htlcPollInFlightRef.current) return;
      htlcPollInFlightRef.current = true;
      try {
        const { order: rawOrder } = await htlcApi.getOrder(
          htlcSolverWait.swapId
        );
        const order = rawOrder as {
          status?: string;
          direction?: "evm-to-canton" | "canton-to-evm";
          counterMode?: string;
          hashLock?: string;
          wbtcAmount?: string;
          userEvmAddress?: string;
          cbtcAmount?: string;
          mainClaimTx?: string;
          counterClaimUpdateId?: string;
        } | null;
        if (cancelled || !order?.status) return;
        const st = order.status;
        if (st === "refunded" || st === "cancelled" || st === "failed") {
          dismissActiveHtlcSwap(htlcSolverWait.swapId);
          setStage({
            kind: "error",
            message: swapWaitTerminalMessage(st)
          });
          return;
        }
        if (htlcSolverWait.mode === "forward") {
          if (order.counterMode === "loop" && st === "main_locked") {
            setStage({
              kind: "htlc-claimable",
              swapId: htlcSolverWait.swapId,
              secret: htlcSolverWait.secret,
              lockTx: htlcSolverWait.lockTx
            });
            return;
          }
          if (
            st === "counter_locked" ||
            st === "counter_claimed" ||
            st === "main_claimed"
          ) {
            setStage({
              kind: "htlc-claimable",
              swapId: htlcSolverWait.swapId,
              secret: htlcSolverWait.secret,
              lockTx: htlcSolverWait.lockTx
            });
          }
          return;
        }
        if (st === "main_claimed") {
          const projected = projectHtlcStatus(
            order as Parameters<typeof projectHtlcStatus>[0]
          );
          forgetSecret(htlcSolverWait.swapId);
          setStage((prev) =>
            prev.kind === "rev-done" && prev.swapId === htlcSolverWait.swapId
              ? {
                  ...prev,
                  settling: !projected.proofComplete,
                  wbtcAmount:
                    (order as { wbtcAmount?: string }).wbtcAmount ??
                    prev.wbtcAmount,
                  cbtcAmount:
                    (order as { cbtcAmount?: string }).cbtcAmount ??
                    prev.cbtcAmount
                }
              : {
                  kind: "rev-done",
                  swapId: htlcSolverWait.swapId,
                  claimTx:
                    htlcUserWbtcClaimTx(
                      order as {
                        direction: "canton-to-evm";
                        mainClaimTx?: string;
                        counterClaimUpdateId?: string;
                      }
                    ) ?? "",
                  wbtcAmount: (order as { wbtcAmount?: string }).wbtcAmount,
                  cbtcAmount: (order as { cbtcAmount?: string }).cbtcAmount,
                  settling: !projected.proofComplete
                }
          );
          return;
        }
        if (st === "counter_claimed" && !htlcSolverWait.settling) {
          setStage({
            kind: "rev-done",
            swapId: htlcSolverWait.swapId,
            claimTx:
              htlcUserWbtcClaimTx({
                direction: "canton-to-evm",
                mainClaimTx: order.mainClaimTx,
                counterClaimUpdateId: order.counterClaimUpdateId
              }) ?? "",
            wbtcAmount: order.wbtcAmount,
            cbtcAmount: order.cbtcAmount,
            settling: true
          });
          return;
        }
        if (st === "main_locked") {
          const started = htlcSolverWait.waitStartedAt ?? Date.now();
          const elapsedSec = Math.floor((Date.now() - started) / 1000);
          if (elapsedSec >= 60) {
            setStage((prev) =>
              prev.kind === "rev-locking" &&
              prev.swapId === htlcSolverWait.swapId &&
              prev.phase === "solver"
                ? {
                    ...prev,
                    solverNote:
                      "The solver is still preparing the WBTC lock. Your CBTC remains locked and refundable if the swap cannot complete before the timeout."
                  }
                : prev
            );
          }
          return;
        }
        if (st === "counter_locked") {
          const meta = order as {
            hashLock?: string;
            wbtcAmount?: string;
            userEvmAddress?: string;
            cbtcAmount?: string;
            counterLockTx?: string;
          };
          if (meta.counterLockTx) {
            setStage({
              kind: "rev-claimable",
              swapId: htlcSolverWait.swapId,
              secret: htlcSolverWait.secret,
              hashLock: meta.hashLock ?? htlcSolverWait.swapId,
              wbtcAmount: meta.wbtcAmount,
              userEvmAddress: meta.userEvmAddress,
              cbtcAmount: meta.cbtcAmount
            });
            return;
          }
          const probe = await isReverseEvmCounterLockReady({
            hashLock: meta.hashLock ?? htlcSolverWait.swapId,
            wbtcAmount: meta.wbtcAmount ?? "0",
            userEvmAddress: meta.userEvmAddress ?? evm.account ?? ""
          });
          if (!probe.ready) {
            startTracking(htlcSolverWait.swapId);
            return;
          }
          setStage({
            kind: "rev-claimable",
            swapId: htlcSolverWait.swapId,
            secret: htlcSolverWait.secret,
            hashLock: meta.hashLock ?? htlcSolverWait.swapId,
            wbtcAmount: meta.wbtcAmount,
            userEvmAddress: meta.userEvmAddress,
            cbtcAmount: meta.cbtcAmount
          });
        }
      } catch {
        /* keep polling */
      } finally {
        htlcPollInFlightRef.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), SWAP_WAIT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [htlcSolverWait, evm.account, startTracking]);

  // The form stays mounted for idle/quoting/error and while the review modal is open.
  const reviewing =
    stage.kind === "quoted" ||
    stage.kind === "approving" ||
    stage.kind === "signing" ||
    stage.kind === "submitting";
  const showForm =
    stage.kind === "idle" ||
    stage.kind === "quoting" ||
    stage.kind === "error" ||
    reviewing;
  const swapInProgress =
    stage.kind === "redirecting" ||
    stage.kind === "htlc-locking" ||
    stage.kind === "htlc-recording" ||
    stage.kind === "rev-locking" ||
    stage.kind === "c2c-waiting";
  // Falls back to fee-only 1:1 (with "≈") until /api/htlc/price loads.
  const receiveDisplay = useMemo(() => {
    if (isC2c) {
      if (
        (stage.kind === "quoted" ||
          stage.kind === "approving" ||
          stage.kind === "signing" ||
          stage.kind === "submitting") &&
        stage.quote.outAmount
      ) {
        return { amount: stage.quote.outAmount, approximate: false };
      }
      if (!amount || amount === ".") {
        return { amount: "0", approximate: false };
      }
      try {
        const asset = getSwapAsset(payLeg.token as CantonSwapAssetId);
        if (toBaseUnits(amount.trim(), asset.decimals) <= 0n) {
          return { amount: "0", approximate: false };
        }
      } catch {
        return { amount: "0", approximate: false };
      }
      if (c2cLiveQuote?.outAmount) {
        return {
          amount: c2cLiveQuote.outAmount,
          approximate: c2cQuoteLoading
        };
      }
      return { amount: "0", approximate: true };
    }
    if (!amount || !/^\d*\.?\d+$/.test(amount)) {
      return { amount: "0", approximate: false };
    }
    try {
      const inUnits = parseWbtc(amount);
      if (inUnits <= 0n) return { amount: "0", approximate: false };
      if (wbtcPrice) {
        const out = quoteOutUnits(
          direction,
          inUnits,
          wbtcPrice.raw,
          wbtcPrice.feeBps
        );
        return { amount: formatWbtc(out), approximate: false };
      }
      const out = (inUnits * BigInt(10000 - FEE_BPS)) / 10000n;
      return { amount: formatWbtc(out), approximate: true };
    } catch {
      return { amount: "0", approximate: false };
    }
  }, [
    amount,
    direction,
    wbtcPrice,
    isC2c,
    payLeg.token,
    stage,
    c2cLiveQuote,
    c2cQuoteLoading
  ]);

  const payTokenLabel = payLeg.chain === "evm" ? "WBTC" : payLeg.token;
  const receiveTokenLabel =
    receiveLeg.chain === "evm" ? "WBTC" : receiveLeg.token;

  const payAmountLimit = useMemo(() => {
    if (!amount || amount === ".") return null;
    const asset = isC2c
      ? swapPayAssetFromToken(payLeg.token)
      : isReverse
        ? ("CBTC" as const)
        : ("WBTC" as const);
    if (!asset) return null;
    return checkSwapPayAmountLimit(asset, amount);
  }, [amount, isC2c, isReverse, payLeg.token]);

  // CoW-style amount validation (TradeFormValidation analogue): compute the
  // amount state once, ordered — the button reflects the FIRST problem.
  //   notSet   → empty or zero  → "Enter an amount" (disabled)
  //   invalid  → parse fails    → "Invalid amount"  (disabled)
  //   overLimit→ above MVP cap  → "Max … per swap"  (disabled)
  //   overBal  → > balance      → "Insufficient WBTC balance" (disabled)
  const amountState = (():
    | "ok"
    | "notSet"
    | "invalid"
    | "overLimit"
    | "overBalance" => {
    if (!amount || amount === ".") return "notSet";
    if (isC2c) {
      try {
        const asset = getSwapAsset(payLeg.token as CantonSwapAssetId);
        const want = toBaseUnits(amount.trim(), asset.decimals);
        if (want <= 0n) return "notSet";
        if (payAmountLimit && !payAmountLimit.ok) return "overLimit";
        const have = toBaseUnits(balanceForLeg(payLeg) ?? "0", asset.decimals);
        if (want > have) return "overBalance";
        return "ok";
      } catch {
        return "invalid";
      }
    }
    let parsed: bigint;
    try {
      parsed = parseWbtc(amount); // 8dp — same precision for WBTC and CBTC
    } catch {
      return "invalid";
    }
    if (parsed <= 0n) return "notSet";
    if (payAmountLimit && !payAmountLimit.ok) return "overLimit";
    if (isReverse) {
      // Selling CBTC — validate against the session party's CBTC balance.
      const cbtcSats = BigInt(Math.round(parseFloat(cbtcBalance || "0") * 1e8));
      if (parsed > cbtcSats) return "overBalance";
      return "ok";
    }
    if (wbtcBalance != null && parsed > wbtcBalance) return "overBalance";
    return "ok";
  })();

  const fetchingQuote =
    stage.kind === "quoting" ||
    (amountState === "ok" &&
      ((isC2c && c2cQuoteLoading) ||
        (!isC2c && !wbtcPrice && !wbtcPriceError)));

  // Single context-aware primary action.
  let primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
  } | null = null;
  if (showForm) {
    if (swapBootstrapping) {
      primary = {
        label: "Loading…",
        onClick: () => {},
        disabled: true,
        busy: true
      };
    } else if (fetchingQuote) {
      primary = {
        label: "Fetching quote…",
        onClick: () => {},
        disabled: true,
        busy: true
      };
    } else if (!isC2c && amountState === "ok" && !wbtcPrice && wbtcPriceError) {
      primary = {
        label: "Quote unavailable",
        onClick: () => {},
        disabled: true
      };
    } else if (swapKind === "invalid-evm-evm") {
      primary = {
        label: "Same-chain EVM swaps not supported",
        onClick: () => {},
        disabled: true
      };
    } else if (swapKind === "invalid-same-asset") {
      primary = {
        label: "Pick two different Canton assets",
        onClick: () => {},
        disabled: true
      };
    } else if (swapKind === "invalid-cross-chain-canton") {
      primary = {
        label: "Cross-chain is WBTC ↔ CBTC only",
        onClick: () => {},
        disabled: true
      };
    } else if (!isC2c && !evm.account) {
      primary = {
        label: evm.available ? "Connect EVM wallet" : "No EVM wallet found",
        onClick: evm.connect,
        disabled: !evm.available
      };
    } else if (!isC2c && wrongChain) {
      primary = {
        label: evm.switchingChain
          ? `Switching to ${SWAP_CHAIN.name}…`
          : `Switch to ${SWAP_CHAIN.name}`,
        onClick: handleSwitchChain,
        busy: evm.switchingChain,
        disabled: evm.switchingChain
      };
    } else if (!loopConnected) {
      primary = {
        label: "Sign in",
        onClick: () => router.push("/login"),
        disabled: false
      };
    } else if (!isC2c && !isParticipantManaged && sessionReady !== true) {
      // LOOP path only: need the one-time Loop-session signature (preapproval gate).
      // Participant-managed users skip this — the backend signs on their behalf.
      primary = {
        label: sessionReady === null ? "Checking…" : "Sign to continue",
        onClick: () => setSessionReady(false),
        disabled: sessionReady === null
      };
    } else if (amountState === "notSet") {
      primary = { label: "Enter an amount", onClick: () => {}, disabled: true };
    } else if (amountState === "invalid") {
      primary = { label: "Invalid amount", onClick: () => {}, disabled: true };
    } else if (amountState === "overLimit") {
      primary = {
        label:
          payAmountLimit && !payAmountLimit.ok
            ? payAmountLimit.message
            : "Amount exceeds swap limit",
        onClick: () => {},
        disabled: true
      };
    } else if (amountState === "overBalance") {
      primary = {
        label: `Insufficient ${payTokenLabel} balance`,
        onClick: () => {},
        disabled: true
      };
    } else {
      primary = {
        label: "Review swap",
        onClick: handleQuote,
        disabled: reviewing || fetchingQuote
      };
    }
  }

  const showPageTitle =
    stage.kind !== "htlc-done" &&
    stage.kind !== "rev-done" &&
    stage.kind !== "c2c-done" &&
    !swapInProgress;

  return (
    <div className="mx-auto w-full max-w-[460px] px-4 py-6 sm:py-10">
      {showPageTitle && (
        <h1 className="mb-4 px-1 text-2xl font-semibold text-foreground">
          Swap
        </h1>
      )}

      <div className="rounded-3xl border border-foreground/10 bg-card p-4 shadow-sm sm:p-5">
        {stage.kind === "redirecting" && (
          <div className="flex justify-center px-1 py-10">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <span className="inline-block size-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            </div>
          </div>
        )}

        {showForm && (
          <>
            <TokenPanel
              title="You pay"
              leg={payLeg}
              otherLeg={receiveLeg}
              onLegChange={changePayLeg}
              cantonAssets={cantonAssets}
              getBalance={balanceForLeg}
              amount={amount}
              editable
              onAmountChange={setAmount}
              balance={balanceForLeg(payLeg)}
              onMax={
                balanceForLeg(payLeg) && parseFloat(balanceForLeg(payLeg)!) > 0
                  ? () => setAmount(balanceForLeg(payLeg)!)
                  : undefined
              }
            />

            <div className="relative z-10 -my-3 flex justify-center">
              <button
                type="button"
                aria-label="Flip swap direction"
                onClick={() => {
                  const { pay, receive } = normalizeSwapLegs(
                    receiveLeg,
                    payLeg,
                    enabledCantonIds
                  );
                  setPayLeg(pay);
                  setReceiveLeg(receive);
                  setAmount("");
                  setStage({ kind: "idle" });
                }}
                title="Flip direction"
                className="flex size-9 items-center justify-center rounded-xl border-4 border-card bg-muted transition-all hover:bg-muted/70 active:scale-95"
              >
                <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                  swap_vert
                </span>
              </button>
            </div>

            <TokenPanel
              title="You receive"
              leg={receiveLeg}
              otherLeg={payLeg}
              onLegChange={changeReceiveLeg}
              cantonAssets={cantonAssets}
              getBalance={balanceForLeg}
              amount={receiveDisplay.amount}
              approximate={receiveDisplay.approximate}
              editable={false}
              balance={balanceForLeg(receiveLeg)}
            />

            <div className="px-1 pb-1 pt-3">
              <DetailRow
                label="Recipient"
                value={
                  isC2c || !isReverse
                    ? loopConnected
                      ? truncatePartyId(destinationParty)
                      : "Sign in"
                    : evm.account
                      ? `${evm.account.slice(0, 8)}…${evm.account.slice(-6)}`
                      : "Connect EVM wallet"
                }
                ok={isC2c || !isReverse ? loopConnected : !!evm.account}
              />
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-foreground/60">Order expiration</span>
                <select
                  value={expirationSeconds}
                  onChange={(e) => setExpirationSeconds(Number(e.target.value))}
                  className="rounded-lg border border-foreground/15 bg-transparent px-2 py-1 text-foreground"
                >
                  {EXPIRATION_OPTIONS.map((o) => (
                    <option key={o.seconds} value={o.seconds}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {stage.kind === "error" &&
              (stage.message.startsWith("Swaps are paused") ? (
                // De-peg circuit breaker — informational (amber), not an error (red).
                <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
                  <span className="material-symbols-outlined mt-0.5 text-[18px] text-amber-500">
                    pause_circle
                  </span>
                  <span>{stage.message}</span>
                </div>
              ) : (
                <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {stage.message}
                </div>
              ))}
            {!isC2c &&
              stage.kind !== "error" &&
              !wbtcPrice &&
              wbtcPriceError &&
              amountState === "ok" && (
                <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
                  <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-amber-500">
                    info
                  </span>
                  <span>{wbtcPriceError}</span>
                </div>
              )}
            {isC2c &&
              c2cQuoteIsError &&
              !c2cQuoteLoading &&
              stage.kind === "idle" &&
              amount &&
              parseFloat(amount) > 0 && (
                <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
                  <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-amber-500">
                    info
                  </span>
                  <span>
                    {formatCantonQuoteError(
                      c2cQuoteError instanceof Error
                        ? c2cQuoteError.message
                        : undefined
                    )}
                  </span>
                </div>
              )}
            {wallet.loopError && (
              <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {wallet.loopError}
              </div>
            )}
            {evm.error && (
              <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {evm.error}
              </div>
            )}

            {primary && (
              <button
                onClick={primary.onClick}
                disabled={primary.disabled || primary.busy}
                className={cn(
                  "mt-1 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]",
                  primary.busy ? "disabled:opacity-90" : "disabled:opacity-50"
                )}
              >
                {primary.busy && (
                  <span className="inline-block size-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
                )}
                {primary.label}
              </button>
            )}
          </>
        )}

        {stage.kind === "htlc-locking" && (
          <div className="px-1 pb-1 pt-2 text-left">
            <SwapStepper
              steps={forwardLoopHtlcSteps({
                phase: "solver",
                networkFeeEnabled: false,
                managed: isParticipantManaged
              })}
            />
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <span className="inline-block size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-foreground">
                  {swapWaitButtonLabel(
                    waitElapsedSec,
                    "solver",
                    false,
                    isParticipantManaged
                  )}
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Your WBTC is locked. The solver is locking CBTC on Canton —
                  usually under a minute.
                </p>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl bg-muted/40">
              <div className="flex items-center justify-between gap-3 border-b border-foreground/5 px-4 py-3">
                <span className="text-sm text-muted-foreground">You pay</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatWbtc(BigInt(stage.quote.order.inputs[0][1]))} WBTC
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  You receive at least
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatWbtc(BigInt(stage.quote.order.outputs[0].amount))} CBTC
                </span>
              </div>
            </div>
            <SwapWaitBanner
              elapsedSec={waitElapsedSec}
              mode="solver"
              forwardManaged={isParticipantManaged}
              orderId={stage.swapId}
              ordersHref={`/swap/orders/${encodeURIComponent(stage.swapId)}`}
              onStartNewSwap={() => dismissToNewSwap(stage.swapId)}
            />
          </div>
        )}

        {stage.kind === "htlc-recording" && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <span className="inline-block size-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            </div>
            <h3 className="text-lg font-semibold">Confirming your WBTC lock…</h3>
            <p className="mt-1 text-sm text-foreground/60">
              The transaction was submitted. WarpX is waiting for the on-chain
              receipt and verifying the escrow state before the solver locks CBTC.
            </p>
            <p className="mt-3 text-xs text-foreground/50">
              Verification has been running for {waitElapsedSec}s.
            </p>
            <Link
              href={`/swap/orders/${encodeURIComponent(stage.swapId)}`}
              className="mt-4 inline-flex text-sm font-medium text-primary hover:underline"
            >
              View order
            </Link>
          </div>
        )}

        {stage.kind === "htlc-resume" && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
              🔓
            </div>
            <h3 className="text-lg font-semibold">Swap ready to claim</h3>
            <p className="mt-1 text-sm text-foreground/60">
              You have a claimable swap from a previous session. Unlock your
              saved secret to continue.
            </p>
            {stage.unlockError && (
              <p className="mt-2 text-sm text-red-500">
                ⚠️ {stage.unlockError}
              </p>
            )}
            <button
              onClick={() =>
                void unlockResumeSecret(
                  stage.swapId,
                  stage.lockTx,
                  "evm-to-canton"
                )
              }
              className="mt-4 w-full rounded-2xl bg-[#b04a2a] px-4 py-3 font-semibold text-white hover:opacity-90"
            >
              Unlock saved secret
            </button>
          </div>
        )}

        {(stage.kind === "htlc-claimable" ||
          stage.kind === "htlc-claiming") && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
              🔓
            </div>
            <h3 className="text-lg font-semibold">
              Both legs locked — claim your CBTC
            </h3>
            <p className="mt-1 text-sm text-foreground/60">
              {!isParticipantManaged
                ? "Loop settlement is trust-minimized: reveal authorizes the venue to claim WBTC and creates a durable CBTC delivery obligation. No separate CC fee payment is required."
                : "Press Claim to reveal your secret and receive your CBTC. The on-ledger Canton hashlock and EVM hashlock bind the managed-wallet swap atomically."}
            </p>
            {stage.kind === "htlc-claimable" && stage.claimError && (
              <p className="mt-2 text-sm text-red-500">⚠️ {stage.claimError}</p>
            )}
            <button
              onClick={() =>
                handleClaim(stage.swapId, stage.secret, stage.lockTx)
              }
              disabled={stage.kind === "htlc-claiming"}
              className={cn(
                "mt-4 w-full rounded-2xl px-4 py-3 font-semibold text-white",
                stage.kind === "htlc-claiming"
                  ? "bg-foreground/40"
                  : "bg-[#b04a2a] hover:opacity-90"
              )}
            >
              {stage.kind === "htlc-claiming" ? "Claiming…" : "Claim CBTC"}
            </button>
            {/* Stuck-swap escape hatch: retake your WBTC (only works after the EVM
                timelock — the contract enforces it). */}
            {stage.kind === "htlc-claimable" && stage.claimError && (
              <button
                onClick={() => handleRetake(stage.swapId)}
                className="mt-2 w-full rounded-2xl border border-foreground/15 px-4 py-2.5 text-sm hover:bg-foreground/5"
              >
                Retake my WBTC (refund — after timelock)
              </button>
            )}
          </div>
        )}

        {stage.kind === "htlc-refunded" && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-foreground/10 text-2xl">
              ↩️
            </div>
            <h3 className="text-lg font-semibold">WBTC refunded</h3>
            <p className="mt-1 text-sm text-foreground/60">
              Your locked WBTC was returned to your wallet (retake).
            </p>
            <p className="mt-2 break-all text-xs text-foreground/40">
              retake tx {stage.retakeTx.slice(0, 16)}…
            </p>
            <button
              onClick={reset}
              className="mt-4 rounded-xl border border-foreground/15 px-4 py-2 text-sm hover:bg-foreground/5"
            >
              New swap
            </button>
          </div>
        )}

        {stage.kind === "htlc-done" && (
          <SwapResultCard
            title="CBTC claimed"
            subtitle="HTLC reveal complete"
            badge="Claim submitted"
            description="Your CBTC has been delivered and the secret has been revealed. The order may show Settling until the solver completes the matching EVM claim."
            rows={[
              {
                label: "You paid",
                value: formatMaybeWbtcAmount(stage.wbtcAmount)
              },
              {
                label: "You received",
                value: formatMaybeCbtcAmount(stage.cbtcAmount)
              },
              {
                label: "Swap ID",
                value: shortHash(stage.swapId),
                copy: stage.swapId
              },
              {
                label: "Lock tx",
                value: shortHash(stage.lockTx),
                copy: stage.lockTx
              }
            ]}
            onReset={reset}
          />
        )}

        {/* ===== REVERSE (canton-to-evm) stages ===== */}
        {stage.kind === "rev-resume" && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
              🔓
            </div>
            <h3 className="text-lg font-semibold">Swap ready to claim</h3>
            <p className="mt-1 text-sm text-foreground/60">
              You have a claimable swap from a previous session. Unlock your
              saved secret to continue.
            </p>
            {stage.unlockError && (
              <p className="mt-2 text-sm text-red-500">
                ⚠️ {stage.unlockError}
              </p>
            )}
            <button
              onClick={() =>
                void unlockResumeSecret(stage.swapId, "", "canton-to-evm")
              }
              className="mt-4 w-full rounded-2xl bg-[#b04a2a] px-4 py-3 font-semibold text-white hover:opacity-90"
            >
              Unlock saved secret
            </button>
          </div>
        )}

        {(stage.kind === "rev-claimable" || stage.kind === "rev-claiming") && (
          <div className="px-1 pb-1 pt-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
              🔓
            </div>
            <h3 className="text-lg font-semibold">
              Both legs locked — claim your WBTC
            </h3>
            <p className="mt-1 text-sm text-foreground/60">
              {isParticipantManaged
                ? "Claim the WBTC in MetaMask. The on-chain claim reveals the secret that atomically unlocks the managed Canton HTLC."
                : "Claim the WBTC in MetaMask. Loop reverse settlement uses temporary venue custody; your on-chain reveal finalizes the venue's right to the deposited CBTC."}
            </p>
            {stage.kind === "rev-claimable" && stage.claimError && (
              <p className="mt-2 text-sm text-red-500">⚠️ {stage.claimError}</p>
            )}
            <button
              onClick={() => {
                if (stage.kind !== "rev-claimable") return;
                handleClaimReverse(stage.swapId, stage.secret, {
                  hashLock: stage.hashLock,
                  wbtcAmount: stage.wbtcAmount,
                  userEvmAddress: stage.userEvmAddress,
                  cbtcAmount: stage.cbtcAmount
                });
              }}
              disabled={stage.kind === "rev-claiming"}
              className={cn(
                "mt-4 w-full rounded-2xl px-4 py-3 font-semibold text-white",
                stage.kind === "rev-claiming"
                  ? "bg-foreground/40"
                  : "bg-[#b04a2a] hover:opacity-90"
              )}
            >
              {stage.kind === "rev-claiming" ? "Claiming…" : "Claim WBTC"}
            </button>
            {/* Stuck-swap escape after the Canton timelock.
                Managed: HtlcLock.Refund. Loop: venue custody-return service. */}
            {stage.kind === "rev-claimable" && stage.claimError && (
              <button
                onClick={() =>
                  void (async () => {
                    try {
                      // Both modes refund via the backend after the timelock:
                      // email = HtlcLock.Refund (CanActAs); loop seller (Variant A
                      // custody) = we send the custodied CBTC straight back.
                      await htlcApi.refundMain(stage.swapId);
                      reset();
                    } catch {
                      /* surfaced via the existing claimError state on retry */
                    }
                  })()
                }
                className="mt-2 w-full rounded-2xl border border-foreground/15 px-4 py-2.5 text-sm hover:bg-foreground/5"
              >
                Refund my CBTC (after timelock)
              </button>
            )}
          </div>
        )}

        {stage.kind === "rev-done" && (
          <SwapResultCard
            title={stage.settling ? "Settling on Canton" : "Swap complete"}
            subtitle={
              stage.settling
                ? "WBTC received — solver claiming CBTC"
                : "HTLC reveal complete"
            }
            badge={stage.settling ? "Settling" : "Completed"}
            description={
              stage.settling
                ? "Your WBTC is in your wallet. The solver is claiming the CBTC leg on Canton — usually under a minute."
                : "You claimed your WBTC and revealed the secret on-chain. The solver used that secret to claim the CBTC leg."
            }
            rows={[
              {
                label: "You paid",
                value: formatMaybeCbtcAmount(stage.cbtcAmount)
              },
              {
                label: "You received",
                value: formatMaybeWbtcAmount(stage.wbtcAmount)
              },
              {
                label: "Swap ID",
                value: shortHash(stage.swapId),
                copy: stage.swapId
              },
              {
                label: "Claim tx",
                value: shortHash(stage.claimTx),
                copy: stage.claimTx
              }
            ]}
            onReset={reset}
          />
        )}

        {stage.kind === "c2c-waiting" && (
          <div className="px-1 pb-1 pt-2 text-left">
            <SwapStepper
              steps={loopC2cSteps({
                phase: stage.note?.toLowerCase().includes("accept")
                  ? "accept"
                  : "fill",
                managed: isParticipantManaged
              })}
            />
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <span className="inline-block size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-foreground">
                  {swapWaitButtonLabel(waitElapsedSec, "settling")}
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {stage.note ??
                    "Settlement is in progress on Canton — usually under a minute."}
                </p>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl bg-muted/40">
              <div className="flex items-center justify-between gap-3 border-b border-foreground/5 px-4 py-3">
                <span className="text-sm text-muted-foreground">You pay</span>
                <span className="text-sm font-semibold tabular-nums">
                  {trimAmount(stage.inAmount)} {stage.fromAsset}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  You receive
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {trimAmount(stage.outAmount)} {stage.toAsset}
                </span>
              </div>
            </div>
            <SwapWaitBanner
              elapsedSec={waitElapsedSec}
              mode="settling"
              orderId={stage.orderId}
              ordersHref={`/swap/orders/${encodeURIComponent(stage.orderId)}`}
              onStartNewSwap={() => dismissToNewSwap()}
            />
          </div>
        )}

        {stage.kind === "c2c-done" && (
          <SwapResultCard
            title="Swap complete"
            subtitle={
              stage.walletMode === "managed"
                ? "Vault-backed swap settled"
                : "Swap settled"
            }
            badge="Completed"
            description={
              stage.walletMode === "managed"
                ? "Your sell leg was offered to the settlement vault and filled with the counter asset in one backend settlement."
                : stage.directCounterDelivery && stage.toAsset === "CC"
                  ? `${trimAmount(stage.outAmount)} CC was credited to your Loop wallet via CC auto-accept (no separate Loop accept prompt). Check your CC balance in the header.`
                  : stage.directCounterDelivery
                    ? `${trimAmount(stage.outAmount)} ${stage.toAsset} was delivered to your Loop wallet.`
                    : "Your swap is complete on Canton."
            }
            rows={[
              {
                label: "You paid",
                value: `${trimAmount(stage.inAmount)} ${stage.fromAsset}`
              },
              {
                label: "You received",
                value: `${trimAmount(stage.outAmount)} ${stage.toAsset}`
              },
              {
                label: "Order ID",
                value: shortHash(stage.orderId),
                copy: stage.orderId
              }
            ]}
            onReset={reset}
          />
        )}
      </div>

      {reviewing && (
        <ReviewModal
          quote={
            stage.kind === "quoted" ||
            stage.kind === "approving" ||
            stage.kind === "signing" ||
            stage.kind === "submitting"
              ? stage.quote
              : null
          }
          retryError={stage.kind === "quoted" ? stage.retryError : undefined}
          busy={
            stage.kind === "approving"
              ? "Approve WBTC in your wallet…"
              : stage.kind === "signing"
                ? "Sign the swap in your wallet…"
                : stage.kind === "submitting"
                  ? stage.quote.direction === "canton-to-canton"
                    ? isParticipantManaged
                      ? "Settling swap…"
                      : stage.c2cPhase === "confirm"
                        ? "Verifying your transfer…"
                        : "Sign in Loop wallet…"
                    : stage.quote.direction === "canton-to-evm"
                      ? isParticipantManaged
                        ? "Locking CBTC on Canton…"
                        : "Sign in Loop wallet…"
                      : `Locking WBTC on ${SWAP_CHAIN.name}…`
                  : null
          }
          expirationSeconds={expirationSeconds}
          evmRecipient={evm.account}
          managedSetup={
            isC2c && isParticipantManaged
              ? {
                  loading: managedPreapprovalLoading,
                  ccTotal: managedPreapproval?.ccTotal ?? "0",
                  ccMin: managedPreapproval?.ccMinToEnable ?? 2,
                  ccEnabled: managedPreapproval?.ccEnabled ?? false,
                  cbtcEnabled: managedPreapproval?.cbtcEnabled ?? false,
                  ccReadyForEnable:
                    managedPreapproval?.ccReadyForEnable ?? false,
                  ccSubsidizedOnDevnet:
                    managedPreapproval?.ccSubsidizedOnDevnet ?? false,
                  needsCcDeposit,
                  needsEnableCc,
                  needsEnableCbtc,
                  enabling: enablingCc,
                  enablingCbtc,
                  error: enableCcError,
                  partyId: destinationParty,
                  swapIssues: managedPreapproval?.swap?.issues,
                  onEnableCc: () =>
                    enableCc().then(() => refetchManagedPreapproval()),
                  onEnableCbtc: () =>
                    enableCbtc().then(() => refetchManagedPreapproval()),
                  onEnableAll: () => enableAllPreapprovals()
                }
              : undefined
          }
          isParticipantManaged={isParticipantManaged}
          isLoopWallet={!isParticipantManaged && !!wallet.provider}
          destinationParty={destinationParty}
          loopProvider={wallet.provider ?? undefined}
          loopPopupBlocked={loopPopupBlocked}
          onOpenLoopWallet={openLoopWallet}
          onRefreshQuote={handleQuote}
          onConfirm={() => {
            if (stage.kind !== "quoted") return;
            if (quoteIsExpired(stage.quote)) {
              void handleQuote();
              return;
            }
            setLoopPopupBlocked(false);
            if (stage.quote.direction === "canton-to-evm") {
              void handleConfirmReverse(stage.quote);
            } else {
              void handleConfirm(stage.quote);
            }
          }}
          onClose={() => {
            setLoopPopupBlocked(false);
            reset();
          }}
        />
      )}

      {/* SIGN PREREQUISITE popup — shown when connected but no JWT session yet.
          Blocks the swap until the user signs once in their Loop wallet. */}
      {needsLoopSignGate && (
        <SignGateModal
          signing={signing}
          error={signError}
          loopPopupBlocked={loopPopupBlocked}
          onOpenLoopWallet={openLoopWallet}
          onSign={handleSign}
        />
      )}

      {/* ENABLE-AUTO-ACCEPT popup — shown when Review found preapproval OFF. */}
      {showEnablePopup && (
        <EnableAutoAcceptModal
          visited={enableVisited}
          checking={enableChecking}
          stillOff={enableVisited && autoAccept === false}
          onOpenSettings={handleOpenLoopSettings}
          onConfirm={handleConfirmAutoAccept}
          onClose={() => setShowEnablePopup(false)}
        />
      )}
    </div>
  );
}

function shortHash(value: string) {
  if (!value) return "—";
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function extractLoopSubmitOfferCid(result: unknown): string | undefined {
  const events = extractEventsByIdFromSubmitResult(result);
  return (
    extractLastCreatedOfferCid(events) ??
    extractCreatedOfferCid(events) ??
    undefined
  );
}

function trimAmount(value: string) {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatMaybeWbtcAmount(value?: string) {
  if (!value) return "—";
  try {
    return `${formatWbtc(BigInt(value))} WBTC`;
  } catch {
    return `${trimAmount(value)} WBTC`;
  }
}

function formatMaybeCbtcAmount(value?: string) {
  if (!value) return "—";
  if (value.includes(".")) return `${trimAmount(value)} CBTC`;
  try {
    return `${formatWbtc(BigInt(value))} CBTC`;
  } catch {
    return `${trimAmount(value)} CBTC`;
  }
}

function SwapResultCard({
  title,
  subtitle = "Swap complete",
  badge,
  description,
  rows,
  onReset
}: {
  title: string;
  subtitle?: string;
  badge: string;
  description: string;
  rows: Array<{ label: string; value: string; copy?: string }>;
  onReset: () => void;
}) {
  const copyValue = (value?: string) => {
    if (!value) return;
    void navigator.clipboard.writeText(value).catch(() => {});
  };

  return (
    <div className="px-1 pb-1 pt-2 text-left">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600">
            <span className="material-symbols-outlined text-[28px]">
              check_circle
            </span>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-semibold text-emerald-600 ring-1 ring-emerald-500/20">
          {badge}
        </span>
      </div>

      <p className="text-sm leading-6 text-muted-foreground">{description}</p>

      <div className="mt-5 overflow-hidden rounded-2xl bg-muted/40">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 border-b border-foreground/5 px-4 py-3 last:border-b-0"
          >
            <span className="text-sm text-muted-foreground">{row.label}</span>
            {row.copy ? (
              <button
                type="button"
                onClick={() => copyValue(row.copy)}
                className="min-w-0 truncate rounded-lg px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-muted"
                title={row.copy}
              >
                {row.value}
              </button>
            ) : (
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                {row.value}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button
          onClick={onReset}
          className="rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]"
        >
          New swap
        </button>
        <Link
          href="/orders"
          className="rounded-2xl border border-foreground/15 px-4 py-3 text-center text-sm font-semibold text-foreground transition-colors hover:bg-foreground/5"
        >
          View orders
        </Link>
      </div>
    </div>
  );
}

/**
 * A Uniswap-style token panel: a big amount on the left, a token/network badge
 * on the right, and an optional balance + MAX row underneath.
 */
function TokenPanel({
  title,
  leg,
  otherLeg,
  onLegChange,
  cantonAssets,
  getBalance,
  amount,
  approximate = false,
  editable,
  onAmountChange,
  balance,
  onMax
}: {
  title: string;
  leg: SwapLeg;
  otherLeg?: SwapLeg;
  onLegChange: (leg: SwapLeg) => void;
  cantonAssets: CantonSwapAssetMeta[];
  getBalance?: (leg: SwapLeg) => string | undefined;
  amount: string;
  approximate?: boolean;
  editable: boolean;
  onAmountChange?: (v: string) => void;
  balance?: string;
  onMax?: () => void;
}) {
  const decimals =
    leg.chain === "evm"
      ? 8
      : (cantonAssets.find((a) => a.id === leg.token)?.decimals ?? 8);

  return (
    <div className="rounded-2xl bg-muted/40 p-4 ring-1 ring-transparent transition-colors focus-within:bg-muted/60 focus-within:ring-foreground/10">
      <div className="mb-1.5 text-sm font-medium text-muted-foreground">
        {title}
      </div>
      <div className="flex items-center justify-between gap-3">
        {editable ? (
          <input
            // CoW-style numeric input: text + inputMode=decimal (keeps trailing
            // dots), keystrokes filtered by the decimal regex, paste cleaned, and
            // truncated to 8dp (WBTC/CBTC precision). Bad keystrokes are no-ops.
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={79}
            value={amount}
            onChange={(e) =>
              onAmountChange?.(
                truncateToDecimals(
                  sanitizeAmountInput(e.target.value, amount),
                  decimals
                )
              )
            }
            onPaste={(e) => {
              e.preventDefault();
              const cleaned = truncateToDecimals(
                cleanPastedAmount(e.clipboardData.getData("text")),
                decimals
              );
              onAmountChange?.(cleaned);
            }}
            placeholder="0.0"
            className="w-full min-w-0 bg-transparent text-[2rem] font-semibold leading-none tracking-tight text-foreground outline-none placeholder:text-on-surface-variant/40"
          />
        ) : (
          <div className="w-full min-w-0 truncate text-[2rem] font-semibold leading-none tracking-tight text-foreground">
            {amount === "0" ? (
              <span className="text-on-surface-variant/40">0.0</span>
            ) : approximate ? (
              `≈ ${amount}`
            ) : (
              amount
            )}
          </div>
        )}
        <SwapLegBadge
          leg={leg}
          otherLeg={otherLeg}
          onChange={onLegChange}
          cantonAssets={cantonAssets}
          getBalance={getBalance}
        />
      </div>
      {/* Balance + MAX row — only on the editable (pay) panel, or when a balance
          is known. Reserves height so the card doesn't jump when it appears. */}
      {(balance !== undefined || onMax) && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {balance !== undefined && (
            <span>
              Balance: <span className="text-foreground/70">{balance}</span>
            </span>
          )}
          {onMax && (
            <button
              onClick={onMax}
              className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              MAX
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A token + network chip (e.g. WBTC on Base / CC on Canton). */
function TokenBadge({ token, network }: { token: string; network: string }) {
  const tokenId: SwapTokenId | null =
    token === "WBTC"
      ? "WBTC"
      : token === "CBTC"
        ? "CBTC"
        : token === "CC"
          ? "CC"
          : token === "USDCX"
            ? "USDCX"
            : null;

  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full bg-card py-1.5 pl-1.5 pr-3 ring-1 ring-foreground/10">
      <span className="relative inline-flex">
        {tokenId ? (
          <>
            <TokenIcon token={tokenId} size="md" />
            <ChainIcon
              network={network}
              className="absolute -bottom-0.5 -right-0.5 size-3.5 ring-2 ring-card"
            />
          </>
        ) : (
          <ChainIcon network={network} />
        )}
      </span>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-foreground">{token}</div>
        <div className="text-[10px] text-muted-foreground">{network}</div>
      </div>
    </div>
  );
}

/** A compact label/value detail row (Uniswap's summary rows). */
function DetailRow({
  label,
  value,
  ok
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex items-center gap-1.5",
          ok === false ? "text-on-surface-variant" : "text-foreground"
        )}
      >
        {value}
        {ok !== undefined && (
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              ok ? "bg-green-500" : "bg-on-surface-variant/40"
            )}
          />
        )}
      </span>
    </div>
  );
}

/**
 * The "You're swapping" confirmation, as a modal overlay (Uniswap/CoW style).
 * Layers over the swap card with a dimmed backdrop. Shows the two headline
 * amounts with token badges, the trade breakdown below, and a Confirm button.
 * While the user is approving/signing/submitting in their wallet (`busy`), the
 * button turns into an inline progress state and the modal can't be dismissed.
 */
function ReviewModal({
  quote,
  retryError,
  busy,
  expirationSeconds,
  evmRecipient,
  managedSetup,
  isParticipantManaged,
  isLoopWallet,
  destinationParty,
  loopProvider,
  loopPopupBlocked,
  onOpenLoopWallet,
  onRefreshQuote,
  onConfirm,
  onClose
}: {
  quote: QuoteResponse | null;
  retryError?: string;
  busy: string | null;
  expirationSeconds: number;
  evmRecipient: string | null;
  managedSetup?: {
    loading: boolean;
    ccTotal: string;
    ccMin: number;
    ccEnabled: boolean;
    cbtcEnabled: boolean;
    ccReadyForEnable: boolean;
    ccSubsidizedOnDevnet: boolean;
    needsCcDeposit: boolean;
    needsEnableCc: boolean;
    needsEnableCbtc: boolean;
    enabling: boolean;
    enablingCbtc: boolean;
    error: string | null;
    partyId?: string;
    swapIssues?: string[];
    onEnableCc: () => Promise<unknown>;
    onEnableCbtc: () => Promise<unknown>;
    onEnableAll: () => Promise<unknown>;
  };
  isParticipantManaged?: boolean;
  isLoopWallet?: boolean;
  destinationParty?: string | null;
  loopProvider?: unknown;
  loopPopupBlocked?: boolean;
  onOpenLoopWallet?: () => void;
  onRefreshQuote: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // Close on Escape — but only when idle (don't yank the modal mid-signing).
  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const [networkFeeLoading, setNetworkFeeLoading] = useState(false);
  const [networkFeeCc, setNetworkFeeCc] = useState<string | undefined>(
    quote?.networkFeeCc
  );
  const [networkFeeUsd, setNetworkFeeUsd] = useState<number | undefined>(
    quote?.networkFeeUsd
  );
  const [networkFeeSource, setNetworkFeeSource] = useState<string | undefined>(
    quote?.networkFeeSource
  );
  const [trafficBytes, setTrafficBytes] = useState<number | undefined>(
    quote?.trafficBytes
  );
  const [networkFeePreview, setNetworkFeePreview] = useState<
    boolean | undefined
  >(quote?.networkFeePreview);
  const [networkFeeTransactions, setNetworkFeeTransactions] = useState<
    import("@/lib/canton-network-fee-math").NetworkFeeTxLeg[] | undefined
  >(quote?.networkFeeTransactions);
  const quoteExpiresAtForTick = quote ? quoteExpiresAtSeconds(quote) : undefined;
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
    if (!quoteExpiresAtForTick || busy) return;
    const timer = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [quoteExpiresAtForTick, busy]);
  useEffect(() => {
    if (!quote) return;

    const applyNetworkFeeFields = (fields: {
      feeCc?: string;
      feeUsd?: number;
      networkFeeSource?: string;
      trafficBytes?: number;
      networkFeePreview?: boolean;
      networkFeeTransactions?: import("@/lib/canton-network-fee-math").NetworkFeeTxLeg[];
    }) => {
      setNetworkFeeCc(fields.feeCc);
      setNetworkFeeUsd(fields.feeUsd);
      setNetworkFeeSource(fields.networkFeeSource);
      setTrafficBytes(fields.trafficBytes);
      setNetworkFeePreview(fields.networkFeePreview);
      setNetworkFeeTransactions(fields.networkFeeTransactions);
    };

    applyNetworkFeeFields({
      feeCc: quote.networkFeeCc,
      feeUsd: quote.networkFeeUsd,
      networkFeeSource: quote.networkFeeSource,
      trafficBytes: quote.trafficBytes,
      networkFeePreview: quote.networkFeePreview,
      networkFeeTransactions: quote.networkFeeTransactions
    });
    logNetworkFeeInBrowser("review modal (from quote)", {
      feeCc: quote.networkFeeCc,
      feeUsd: quote.networkFeeUsd,
      trafficBytes: quote.trafficBytes,
      networkFeeSource: quote.networkFeeSource,
      networkFeePreview: quote.networkFeePreview
    });

    const quoteNetworkFeeEnabled =
      quote.networkFeeCharged === true ||
      (NETWORK_FEE_UI_ENABLED && quote.networkFeePreview === true);
    if (!quoteNetworkFeeEnabled) {
      setNetworkFeeLoading(false);
      return;
    }

    if (
      quote.direction === "canton-to-canton" &&
      isParticipantManaged &&
      destinationParty &&
      quote.fromAsset &&
      quote.toAsset
    ) {
      let cancelled = false;
      setNetworkFeeLoading(true);
      void cantonSwapApi
        .estimateNetworkFee({
          action: "c2c-managed-settle",
          userParty: destinationParty,
          fromAsset: quote.fromAsset,
          toAsset: quote.toAsset,
          inAmount: quote.inAmount,
          outAmount: quote.outAmount
        })
        .then((est) => {
          if (cancelled) return;
          applyNetworkFeeFields({
            feeCc: est.feeCc,
            feeUsd: est.feeUsd,
            networkFeeSource: est.networkFeeSource,
            trafficBytes: est.trafficBytes,
            networkFeePreview: est.networkFeePreview,
            networkFeeTransactions: est.networkFeeTransactions
          });
          logNetworkFeeInBrowser("review modal estimate c2c", est);
        })
        .catch((e) => {
          console.warn("[OranjSwap network-fee] c2c estimate failed", e);
        })
        .finally(() => {
          if (!cancelled) setNetworkFeeLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    if (
      isParticipantManaged &&
      destinationParty &&
      (quote.direction === "evm-to-canton" ||
        quote.direction === "canton-to-evm")
    ) {
      const action =
        quote.direction === "canton-to-evm" ? "htlc-lock" : "htlc-claim";
      let cancelled = false;
      setNetworkFeeLoading(true);
      void cantonSwapApi
        .estimateNetworkFee({
          action,
          userParty: destinationParty,
          cbtcAmount: (Number(quote.cbtcAmount) / 1e8).toFixed(8)
        })
        .then((est) => {
          if (cancelled) return;
          applyNetworkFeeFields({
            feeCc: est.feeCc,
            feeUsd: est.feeUsd,
            networkFeeSource: est.networkFeeSource,
            trafficBytes: est.trafficBytes,
            networkFeePreview: est.networkFeePreview,
            networkFeeTransactions: est.networkFeeTransactions
          });
          logNetworkFeeInBrowser(`review modal estimate ${action}`, est);
        })
        .catch((e) => {
          console.warn("[OranjSwap network-fee] htlc estimate failed", e);
        })
        .finally(() => {
          if (!cancelled) setNetworkFeeLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

  }, [
    quote,
    isParticipantManaged,
    isLoopWallet,
    destinationParty,
    loopProvider
  ]);

  // M-06 (rules-of-hooks): this effect MUST run before the `if (!quote) return null`
  // early return below, or the hook order differs between renders. It derives its
  // own guards from props (quote/managedSetup), all available here.
  const isC2cForSetup = quote?.direction === "canton-to-canton";
  const setupBusyForEffect =
    !!managedSetup && (managedSetup.enabling || managedSetup.enablingCbtc);
  useEffect(() => {
    if (!managedSetup || !isC2cForSetup || managedSetup.loading || busy) return;
    if (managedSetup.needsCcDeposit) return;
    if (
      (managedSetup.needsEnableCc || managedSetup.needsEnableCbtc) &&
      !setupBusyForEffect
    ) {
      void managedSetup.onEnableAll().catch(() => {});
    }
  }, [managedSetup, isC2cForSetup, busy, setupBusyForEffect]);

  if (!quote) return null;

  const isC2c = quote.direction === "canton-to-canton";
  const reverse = quote.direction === "canton-to-evm";
  const quoteChargesCantonNetworkFee = quote.networkFeeCharged === true;
  const hideCantonNetworkFee =
    (!quoteChargesCantonNetworkFee && !NETWORK_FEE_UI_ENABLED) ||
    (!!isLoopWallet && !isParticipantManaged);
  const feeBps = quote.feeBps ?? 0;

  let payAmount: string;
  let payToken: string;
  let payNetwork: string;
  let receiveAmount: string;
  let receiveToken: string;
  let receiveNetwork: string;
  let rateLabel: string;
  let feeLabel: string;
  let recipientLabel: string;

  if (isC2c) {
    payAmount = quote.inAmount ?? "0";
    payToken = quote.fromAsset ?? "CBTC";
    payNetwork = "Canton";
    receiveAmount = quote.outAmount ?? "0";
    receiveToken = quote.toAsset ?? "CBTC";
    receiveNetwork = "Canton";
    const payN = parseFloat(payAmount);
    const recvN = parseFloat(receiveAmount);
    rateLabel =
      payN > 0 && recvN > 0
        ? `1 ${payToken} ≈ ${(recvN / payN).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${receiveToken}`
        : "—";
    feeLabel = feeBps <= 0 ? "Free" : `${feeBps / 100}%`;
    recipientLabel = truncatePartyId(quote.cantonParty);
  } else {
    const priceScale = 10n ** BigInt(quote.wbtcPriceDecimals ?? 8);
    const priceRaw = quote.wbtcPriceRaw
      ? BigInt(quote.wbtcPriceRaw)
      : priceScale;
    const cbtcUnits = BigInt(quote.cbtcAmount);
    const wbtcUnits = BigInt(
      quote.wbtcAmount ?? quote.order.outputs[0]?.amount ?? "0"
    );
    const cbtc = formatWbtc(cbtcUnits);
    const wbtc = formatWbtc(wbtcUnits);
    const cbtcPerWbtc = formatWbtc((priceRaw * 100_000_000n) / priceScale);
    const wbtcPerCbtc = formatWbtc((100_000_000n * 100_000_000n) / priceRaw);
    rateLabel = reverse
      ? `1 CBTC = ${wbtcPerCbtc} WBTC`
      : `1 WBTC = ${cbtcPerWbtc} CBTC`;
    feeLabel = (() => {
      if (feeBps <= 0) return "Free";
      if (reverse) {
        const wbtcBeforeFee = quoteGrossOutUnits(
          "canton-to-evm",
          cbtcUnits,
          priceRaw
        );
        return `${feeBps / 100}% (−${formatWbtc(wbtcBeforeFee - wbtcUnits)} WBTC)`;
      }
      const cbtcBeforeFee = quoteGrossOutUnits(
        "evm-to-canton",
        wbtcUnits,
        priceRaw
      );
      return `${feeBps / 100}% (−${formatWbtc(cbtcBeforeFee - cbtcUnits)} CBTC)`;
    })();
    recipientLabel = reverse
      ? evmRecipient
        ? `${evmRecipient.slice(0, 8)}…${evmRecipient.slice(-6)}`
        : "Connect EVM wallet"
      : truncatePartyId(quote.cantonParty);
    payAmount = reverse ? cbtc : wbtc;
    payToken = reverse ? "CBTC" : "WBTC";
    payNetwork = reverse ? "Canton" : SWAP_CHAIN.name;
    receiveAmount = reverse ? wbtc : cbtc;
    receiveToken = reverse ? "WBTC" : "CBTC";
    receiveNetwork = reverse ? SWAP_CHAIN.name : "Canton";
  }

  const reviewPayAsset = swapPayAssetFromToken(payToken);
  const reviewPayLimit = reviewPayAsset
    ? checkSwapPayAmountLimit(reviewPayAsset, payAmount)
    : null;

  const refundAt = new Date(
    (Math.floor(Date.now() / 1000) + expirationSeconds) * 1000
  ).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const setupBusy =
    !!managedSetup && (managedSetup.enabling || managedSetup.enablingCbtc);

  // (auto-enable effect moved above the `if (!quote) return null` early return — see
  // M-06 rules-of-hooks fix.)

  let setupError: string | null = null;
  if (managedSetup && isC2c && !busy) {
    if (managedSetup.loading) {
      setupError = null;
    } else if (managedSetup.needsCcDeposit) {
      setupError = managedSetup.partyId
        ? `Deposit at least ${managedSetup.ccMin} CC on your Canton party first. Send CC to ${truncatePartyId(managedSetup.partyId)} from Account → Send.`
        : `Deposit at least ${managedSetup.ccMin} CC on your Canton party first.`;
    } else if (
      !setupBusy &&
      (managedSetup.needsEnableCc || managedSetup.needsEnableCbtc)
    ) {
      setupError = null;
    } else if (managedSetup.swapIssues && managedSetup.swapIssues.length > 0) {
      setupError = managedSetup.swapIssues.join(" ");
    } else if (managedSetup.error) {
      setupError = managedSetup.error;
    }
  }

  const quoteExpiresAt = quoteExpiresAtSeconds(quote);
  const quoteSecondsRemaining =
    typeof quoteExpiresAt === "number" ? quoteExpiresAt - nowSec : undefined;
  const quoteExpired =
    !busy &&
    typeof quoteSecondsRemaining === "number" &&
    quoteSecondsRemaining <= 0;
  const quoteExpiryLabel =
    typeof quoteSecondsRemaining === "number"
      ? formatQuoteCountdown(quoteSecondsRemaining)
      : undefined;
  const quoteExpiredError = quoteExpired
    ? "This quote expired. Get a fresh quote before confirming so the swap uses current pricing."
    : null;
  const blockingError = retryError ?? quoteExpiredError ?? setupError;
  const needsLoopSignOnConfirm =
    !!isLoopWallet &&
    !isParticipantManaged &&
    (isC2c || quote.direction === "canton-to-evm");
  const loopBusy = !!busy && busy.toLowerCase().includes("loop");
  const [loopStalled, setLoopStalled] = useState(false);
  useEffect(() => {
    if (!loopBusy) {
      setLoopStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setLoopStalled(true), 4000);
    return () => window.clearTimeout(timer);
  }, [loopBusy]);

  let actionLabel = "Confirm swap";
  let actionDisabled = !!busy;
  let actionOnClick: () => void = onConfirm;

  if (quoteExpired) {
    actionLabel = "Get fresh quote";
    actionOnClick = onRefreshQuote;
  } else if (!busy && reviewPayLimit && !reviewPayLimit.ok) {
    actionLabel = reviewPayLimit.message;
    actionDisabled = true;
  } else if (managedSetup && isC2c && !busy) {
    if (managedSetup.loading || setupBusy) {
      actionDisabled = true;
    } else if (
      managedSetup.needsCcDeposit ||
      managedSetup.needsEnableCc ||
      managedSetup.needsEnableCbtc ||
      (managedSetup.swapIssues && managedSetup.swapIssues.length > 0) ||
      managedSetup.error
    ) {
      actionDisabled = true;
    }
  }

  if (!actionDisabled && retryError) {
    actionLabel = "Try again";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop — click to dismiss when idle. */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={busy ? undefined : onClose}
      />

      <div className="relative w-full max-w-[440px] rounded-3xl border border-foreground/10 bg-card p-5 shadow-xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            You&rsquo;re swapping
          </h2>
          <button
            onClick={onClose}
            disabled={!!busy}
            aria-label="Close"
            className="rounded-full p-1 text-on-surface-variant transition-all hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        {/* Headline amounts with token badges (Uniswap review style) */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <div className="text-3xl font-medium text-foreground">
              {payAmount} {payToken}
            </div>
            <TokenBadge token={payToken} network={payNetwork} />
          </div>
          <div className="my-2 pl-1 text-on-surface-variant">
            <span className="material-symbols-outlined text-[22px]">
              arrow_downward
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-3xl font-medium text-foreground">
              {receiveAmount} {receiveToken}
            </div>
            <TokenBadge token={receiveToken} network={receiveNetwork} />
          </div>
        </div>

        {/* Trade details */}
        <div className="mt-5 border-t border-foreground/10 pt-4">
          <div className="flex flex-col gap-1.5 text-sm">
            <DetailRow label="Rate" value={rateLabel} />
            {quoteExpiryLabel && (
              <DetailRow label="Quote expires" value={quoteExpiryLabel} />
            )}
          </div>
          <FeeBreakdown
            platformFeeLabel={feeLabel}
            networkFeeCc={networkFeeCc}
            networkFeeUsd={networkFeeUsd}
            networkFeeSource={networkFeeSource}
            trafficBytes={trafficBytes}
            networkFeeTransactions={networkFeeTransactions}
            networkFeePreview={networkFeePreview}
            hideCantonNetworkFee={hideCantonNetworkFee}
            loading={networkFeeLoading}
          />
          <div className="mt-1.5 flex flex-col gap-1.5 text-sm">
            <DetailRow
              label="You receive at least"
              value={`${receiveAmount} ${receiveToken}`}
            />
            <DetailRow label="Recipient" value={recipientLabel} />
          </div>
          {!isC2c && <DetailRow label="Refundable after" value={refundAt} />}
        </div>

        {blockingError && !busy && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
            {blockingError}
          </div>
        )}

        {needsLoopSignOnConfirm && !busy && !blockingError && (
          <LoopWalletHint className="mt-4" icon="open_in_new">
            {LOOP_WALLET_POPUP_HINT}
          </LoopWalletHint>
        )}

        {loopPopupBlocked && !busy && (
          <LoopWalletHint
            className="mt-4"
            variant="blocked"
            icon="block"
            actionLabel="Open Loop wallet"
            onAction={onOpenLoopWallet}
          >
            {LOOP_POPUP_BLOCKED_HINT}
          </LoopWalletHint>
        )}

        {/* Primary action — turns into an inline progress state while busy. */}
        <button
          onClick={actionOnClick}
          disabled={actionDisabled}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? (
            <>
              <span className="inline-block size-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
              {busy}
            </>
          ) : (
            actionLabel
          )}
        </button>

        {loopBusy && (
          <>
            <LoopWalletHint className="mt-3" icon="account_balance_wallet">
              {LOOP_WALLET_PENDING_HINT}
            </LoopWalletHint>
            {(loopStalled || loopPopupBlocked) && (
              <LoopWalletHint
                className="mt-3"
                variant="blocked"
                icon="block"
                actionLabel="Open Loop wallet"
                onAction={onOpenLoopWallet}
              >
                {LOOP_POPUP_STALLED_HINT}
              </LoopWalletHint>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SignGateModal({
  signing,
  error,
  loopPopupBlocked,
  onOpenLoopWallet,
  onSign
}: {
  signing: boolean;
  error: string | null;
  loopPopupBlocked?: boolean;
  onOpenLoopWallet?: () => void;
  onSign: () => void;
}) {
  const [signStalled, setSignStalled] = useState(false);
  useEffect(() => {
    if (!signing) {
      setSignStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setSignStalled(true), 4000);
    return () => window.clearTimeout(timer);
  }, [signing]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-full max-w-[440px] rounded-3xl border border-foreground/10 bg-card p-6 shadow-xl">
        <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-primary/10">
          <span className="material-symbols-outlined text-[24px] text-primary">
            encrypted
          </span>
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          One quick signature to continue
        </h2>
        <p className="mt-2 text-sm text-on-surface-variant">
          Sign a message in your Loop wallet so OranjSwap can confirm your swap
          settings and track delivery. It&rsquo;s a one-time signature and{" "}
          <span className="font-medium text-foreground">moves no funds</span>.
        </p>
        <LoopWalletHint className="mt-3" icon="open_in_new">
          {LOOP_WALLET_POPUP_HINT}
        </LoopWalletHint>

        {(loopPopupBlocked || error === LOOP_POPUP_BLOCKED_HINT) && (
          <LoopWalletHint
            className="mt-3"
            variant="blocked"
            icon="block"
            actionLabel="Open Loop wallet"
            onAction={onOpenLoopWallet}
          >
            {LOOP_POPUP_BLOCKED_HINT}
          </LoopWalletHint>
        )}

        {error && error !== LOOP_POPUP_BLOCKED_HINT && (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <button
          onClick={onSign}
          disabled={signing}
          className="mt-5 w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
        >
          {signing ? "Check your Loop wallet…" : "Sign in Loop wallet"}
        </button>
        {signing && (
          <>
            <LoopWalletHint className="mt-3" icon="account_balance_wallet">
              {LOOP_WALLET_PENDING_HINT}
            </LoopWalletHint>
            {signStalled && (
              <LoopWalletHint
                className="mt-3"
                variant="blocked"
                icon="block"
                actionLabel="Open Loop wallet"
                onAction={onOpenLoopWallet}
              >
                {LOOP_POPUP_STALLED_HINT}
              </LoopWalletHint>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ENABLE-AUTO-ACCEPT modal. Shown when Review finds CBTC auto-accept is OFF —
 * which would let the swap take the user's WBTC before they hold the CBTC. The
 * CTA first opens Loop settings; once the user has visited, it flips to a
 * "confirm" CTA that re-checks the status.
 */
function EnableAutoAcceptModal({
  visited,
  checking,
  stillOff,
  onOpenSettings,
  onConfirm,
  onClose
}: {
  visited: boolean;
  checking: boolean;
  stillOff: boolean;
  onOpenSettings: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[440px] rounded-3xl border border-foreground/10 bg-card p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-amber-500/10">
            <span className="material-symbols-outlined text-[24px] text-amber-500">
              bolt
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-on-surface-variant transition-all hover:bg-muted hover:text-foreground"
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          Turn on auto-accept to swap
        </h2>
        <p className="mt-2 text-sm text-on-surface-variant">
          Auto-accept lets the swapped CBTC land in your wallet automatically,
          so your WBTC is only taken once you have the CBTC. Enable{" "}
          <span className="font-medium text-foreground">
            &ldquo;Automatically accept incoming utility transfers&rdquo;
          </span>{" "}
          in your Loop settings.
        </p>

        {stillOff && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
            Still off — toggle it on in Loop settings, then confirm again.
          </div>
        )}

        {!visited ? (
          <button
            onClick={onOpenSettings}
            className="mt-5 w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]"
          >
            Open Loop settings
          </button>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={onConfirm}
              disabled={checking}
              className="w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
            >
              {checking ? "Checking…" : "I've enabled it — confirm"}
            </button>
            <button
              onClick={onOpenSettings}
              className="w-full rounded-2xl py-2 text-sm text-on-surface-variant transition-all hover:text-foreground"
            >
              Open Loop settings again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
