"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ChainIcon } from "@/components/ChainIcon";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWallet";
import { useVaultContext } from "@/hooks/useVaultContext";
import { useBalance } from "@/hooks/useBalance";
import { usePendingOrders, type TrackedOrder } from "@/hooks/usePendingOrders";
import {
  hasCbtcAutoAccept,
  swapSessionActive,
  mintSwapSession
} from "@/lib/swap-accept";
import { truncatePartyId } from "@/lib/format";
import { loopSettingsUrl, MIN_CC_BALANCE, DEFAULT_PLATFORM_FEE_BPS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  getQuote,
  submitOrder,
  refundOrder,
  SWAP_STEPS,
  STEP_FOR_PROGRESS,
  deriveProgress,
  PROGRESS_COPY,
  PENDING_BUFFER_SECONDS,
  getSwapErrorMessage,
  isUserRejection,
  ApiError,
  type QuoteResponse,
  type OrderView
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
  evmApproveAndLock,
  evmClaim,
  evmRetake
} from "@/lib/htlc-client";
import { listLoopCbtcHoldingCids } from "@/lib/loop-holdings";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSwapClaimable } from "@/lib/htlc-order-logic";
import type { SwapStatus } from "@/lib/htlc-types";
import {
  forgetSecret,
  rememberSecret,
  recallSecret,
  readActiveHtlcSwap,
  vaultExpiryFromTimelock,
  vaultMetaFromOrder,
  type SecretVaultMeta
} from "@/lib/secret-vault";
import {
  timelocksFromExpiration,
  EXPIRATION_OPTIONS,
  DEFAULT_EXPIRATION_SECONDS
} from "@/lib/htlc-timelock";

// HTLC EVM leg config (Base Sepolia). The new trustless escrow (replaces the old
// oracle InputSettlerEscrow for swaps). Shared resolver fails closed in production.
const HTLC_ESCROW = HTLC_ESCROW_ADDRESS;
const SOLVER_EVM =
  process.env.NEXT_PUBLIC_SOLVER_EVM ??
  "0x0B95ec21579aee6Ef7b712976bD86689D68b5A08";
const SOLVER_CANTON = process.env.NEXT_PUBLIC_SOLVER_CANTON ?? "";

type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  // `retryError` lets a rejected approve/sign return to the quote (don't lose it).
  | { kind: "quoted"; quote: QuoteResponse; retryError?: string }
  | { kind: "approving"; quote: QuoteResponse }
  | { kind: "signing"; quote: QuoteResponse }
  | { kind: "submitting"; quote: QuoteResponse }
  | { kind: "tracking"; orderId: string; order: OrderView | null }
  // HTLC: waiting for the independent solver to lock the CBTC counter.
  | {
      kind: "htlc-locking";
      quote: QuoteResponse;
      swapId: string;
      secret: string;
      lockTx: string;
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
  | { kind: "rev-locking"; swapId: string; secret: string }
  | {
      kind: "rev-claimable";
      swapId: string;
      secret: string;
      claimError?: string;
    }
  | { kind: "rev-resume"; swapId: string; unlockError?: string }
  | { kind: "rev-claiming"; swapId: string; secret: string }
  | {
      kind: "rev-done";
      swapId: string;
      claimTx: string;
      wbtcAmount?: string;
      cbtcAmount?: string;
    }
  | { kind: "error"; message: string };

// NOTE: pending-order persistence + multi-order tracking now lives in
// usePendingOrders (the CoW-style order list). The single-active-order key is gone.

/** Bridge fee in basis points for the pre-quote "You receive" estimate. Must
 *  match the server's PLATFORM_FEE_BPS (default 100 = 1%). The review modal shows
 *  the exact fee from the server quote. */
const FEE_BPS = Number(process.env.NEXT_PUBLIC_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS);

export default function SwapPage() {
  const evm = useEvmWallet();
  const wallet = useWallet();

  // PARTICIPANT-MANAGED (default): the CBTC recipient is the logged-in user's party
  // hosted on OUR warpx node (fetched from /api/parties/me). The backend signs the
  // on-ledger claim for them (CanActAs) — no Loop wallet needed. We fall back to the
  // connected Loop party only if there's no session (the legacy/Loop path).
  const [sessionParty, setSessionParty] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [sessionReadyAuth, setSessionReadyAuth] = useState(false);
  const [identityProbed, setIdentityProbed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/parties/me")
      .then((r) => r.json())
      .then((d) => {
        if (alive) {
          setSessionParty(d?.partyId ?? null);
          setSessionReadyAuth(!!d?.authed);
        }
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

  const destinationParty =
    process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ?? sessionParty ?? wallet.partyId;
  // True once we have a usable recipient party (session party OR Loop wallet).
  const loopConnected = !!destinationParty;

  // GATE: no Canton party = no identity → /login. Wait until BOTH the session probe
  // and the Loop wallet have finished loading so we don't redirect prematurely.
  const router = useRouter();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SWAP_DEST_PARTY) return; // test override: never gate
    if (!identityProbed || wallet.isLoading) return;
    if (!destinationParty) router.replace("/login");
  }, [identityProbed, wallet.isLoading, destinationParty, router]);
  // Is this a participant-managed swap (backend signs the claim) vs Loop (user signs)?
  const isParticipantManaged =
    !!sessionParty && destinationParty === sessionParty;

  const vaultRecallContext = useVaultContext({
    loopProvider: wallet.provider,
    evmAddress: evm.account,
    sessionUserId,
    sessionPartyId: sessionParty
  });

  const persistSwapSecret = useCallback(
    async (
      swapId: string,
      secret: string,
      meta: Omit<SecretVaultMeta, "expiresAt"> & {
        userTimelock: number;
        solverTimelock?: number;
      }
    ) => {
      const ok = await rememberSecret(
        swapId,
        secret,
        {
          ...meta,
          expiresAt: vaultExpiryFromTimelock(meta.userTimelock, {
            direction: meta.direction,
            solverTimelock: meta.solverTimelock
          })
        },
        await vaultRecallContext()
      );
      if (!ok) {
        throw new Error(
          "Could not save the swap secret on this device. Reconnect your wallet/account and try again before locking funds."
        );
      }
    },
    [vaultRecallContext]
  );

  // Amount starts EMPTY (CoW-style) — no default value. The input shows its "0.0"
  // placeholder and the button reads "Enter an amount" until the user types. All
  // downstream logic (receiveEstimate, amountState) already treats "" as not-set.
  const [amount, setAmount] = useState("");
  // Swap direction. canton-to-evm (sell CBTC) is EMAIL/participant-managed only in
  // v1 (Loop sellers = phase 2, see docs/canton-to-evm-design.md).
  const [direction, setDirection] = useState<"evm-to-canton" | "canton-to-evm">(
    "evm-to-canton"
  );
  const isReverse = direction === "canton-to-evm";
  // Order expiration (Cancore §8) → drives the staggered HTLC timelocks.
  const [expirationSeconds, setExpirationSeconds] = useState<number>(
    DEFAULT_EXPIRATION_SECONDS
  );
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [wbtcBalance, setWbtcBalance] = useState<bigint | null>(null);

  // CoW-style list of in-flight swaps — every submitted order is tracked here and
  // polled independently, so starting a new swap (or another tab) never orphans a
  // prior one. The big `stage="tracking"` view follows the most-recently-submitted
  // order; older ones show in the "Your swaps" panel below the form.
  const { orders: pendingOrders, addOrder, dismissOrder } = usePendingOrders();

  // CBTC balance from the connected Loop wallet (for the "You receive" panel).
  const {
    total: cbtcBalance,
    ccReady,
    ccSubsidizedOnDevnet
  } = useBalance();

  const ccBlocksCantonSwap =
    isParticipantManaged && ccReady === false && !ccSubsidizedOnDevnet;

  const wrongChain = evm.chainId != null && evm.chainId !== SWAP_CHAIN.id;

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

  // --- ENABLE-AUTO-ACCEPT popup. Shown when Review finds preapproval OFF. The
  //     CTA first sends the user to Loop settings; on return it flips to a
  //     "confirm" CTA that re-checks the status. ---
  const [showEnablePopup, setShowEnablePopup] = useState(false);
  const [enableVisited, setEnableVisited] = useState(false); // user went to settings
  const [enableChecking, setEnableChecking] = useState(false);

  // (Polling + its cleanup now live in usePendingOrders — nothing to tear down here.)

  // --- SIGN PREREQUISITE: when the swap screen is open and the Loop wallet is
  //     connected, check whether we already have a valid JWT session. If yes →
  //     ready. If no → the sign popup is shown (sessionReady=false), blocking the
  //     form until the user signs. This is a pure probe (NO signature). ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Participant-managed (email) users don't have a Loop session — the backend
      // signs for them, so there's no preapproval signature to check. Mark ready.
      if (isParticipantManaged) {
        if (!cancelled) setSessionReady(true);
        return;
      }
      if (!wallet.provider) {
        if (!cancelled) setSessionReady(null);
        return;
      }
      if (!cancelled) setSessionReady(null); // checking
      const active = await swapSessionActive();
      if (!cancelled) setSessionReady(active);
    })();
    return () => {
      cancelled = true;
    };
  }, [isParticipantManaged, wallet.provider]);

  // --- The explicit "Sign in your Loop wallet" action (driven by the prerequisite
  //     popup CTA). One signature → mints the JWT session → unblocks the form. ---
  const handleSign = useCallback(async () => {
    if (!wallet.provider) return;
    setSignError(null);
    setSigning(true);
    try {
      const ok = await mintSwapSession(wallet.provider);
      setSessionReady(ok);
      if (!ok) {
        setSignError(
          "Signature was declined or couldn't be verified. Please try again to continue."
        );
      }
    } catch {
      setSessionReady(false);
      setSignError("Something went wrong while signing. Please try again.");
    } finally {
      setSigning(false);
    }
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
    wallet.provider,
    sessionReady,
    probeCbtcAutoAccept
  ]);

  const fail = (message: string) => setStage({ kind: "error", message });

  // --- switch wallet to the configured swap chain (adds it if unknown) ---
  const handleSwitchChain = useCallback(async () => {
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

  // --- 1. quote (both directions) ---
  const handleQuote = useCallback(async () => {
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
    if (ccBlocksCantonSwap) {
      fail(
        `Insufficient CC for Canton network fees (need at least ${MIN_CC_BALANCE} CC).`
      );
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
              direction: "canton-to-evm"
            }
          : {
              user: evm.account,
              wbtcAmount: inUnits.toString(),
              cantonParty: destinationParty,
              direction: "evm-to-canton"
            }
      );
      if (!isReverse) void refreshBalance(quote.wbtc);
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
    evm.account,
    destinationParty,
    amount,
    isReverse,
    refreshBalance,
    wallet.provider,
    sessionReady,
    isParticipantManaged,
    ccBlocksCantonSwap,
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

  // Begin tracking a freshly-submitted order: register it in the persistent
  // pending-orders list (which polls it independently and survives refresh/tabs)
  // and focus the detailed stage view on it. The list — not this function — owns
  // polling + persistence + pruning now, so nothing is orphaned by a later swap.
  const startTracking = useCallback(
    (orderId: string) => {
      addOrder(orderId);
      setStage({ kind: "tracking", orderId, order: null });
    },
    [addOrder]
  );

  // --- 2. approve (if needed) + 3. sign + 4. submit ---
  // Recoverable failures (rejected approve/sign, transient submit) return to the
  // `quoted` stage with a retryError so the user can retry WITHOUT re-quoting.
  const handleConfirm = useCallback(
    async (quote: QuoteResponse) => {
      const retry = (msg: string) =>
        setStage({ kind: "quoted", quote, retryError: msg });
      if (!evm.account) {
        retry("Wallet disconnected — reconnect and try again.");
        return;
      }
      if (!SOLVER_CANTON) {
        retry(
          "Solver Canton party not configured (NEXT_PUBLIC_SOLVER_CANTON)."
        );
        return;
      }
      const wbtcUnits = BigInt(quote.order.inputs[0][1]);
      const cbtcUnits = BigInt(quote.order.outputs[0].amount);
      const cbtcAmount = (Number(cbtcUnits) / 1e8).toFixed(8); // CBTC decimal string

      // ===== HTLC FLOW (trustless EVM leg + Cancore-style reveal on CBTC) =====
      // 1. generate the secret (stays in the browser until the reveal) + create order
      const { secret, hashLock } = generateSecret();
      const id = hashLock; // swapId = hashLock
      const now = Math.floor(Date.now() / 1000);
      // Derive the staggered timelocks from the chosen order expiration (Cancore §8):
      // userTimelock (EVM, = now + expiration) > solverTimelock (Canton, − gap).
      const { userTimelock, solverTimelock } = timelocksFromExpiration(
        now,
        expirationSeconds
      );
      try {
        setStage({ kind: "submitting", quote });
        await htlcApi.createOrder({
          id,
          direction: "evm-to-canton",
          hashLock,
          userEvmAddress: evm.account,
          solverEvmAddress: SOLVER_EVM,
          wbtcAmount: wbtcUnits.toString(),
          userTimelock,
          userCantonParty: quote.cantonParty,
          solverCantonParty: SOLVER_CANTON,
          cbtcAmount,
          solverTimelock,
          // managed (email) → on-ledger HtlcLock; loop → standard transfer + accept.
          counterMode: isParticipantManaged ? "managed" : "loop"
        });
        await htlcApi.accept(id); // (the independent solver also accepts; idempotent)
        await persistSwapSecret(id, secret, {
          direction: "evm-to-canton",
          counterMode: isParticipantManaged ? "managed" : "loop",
          userCantonParty: quote.cantonParty,
          userEvmAddress: evm.account,
          userTimelock,
          solverTimelock
        });
      } catch (e) {
        retry(`Could not create the swap order: ${getSwapErrorMessage(e)}`);
        return;
      }

      // 2/3. approve WBTC to the HTLC escrow + lock it (MetaMask) — THE USER's action.
      let lockTx: string;
      try {
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
        await htlcApi.recordMainLock(id, lockTx);
      } catch (e) {
        retry(
          isUserRejection(e)
            ? "Lock cancelled. Approve + lock your WBTC to start the swap."
            : getSwapErrorMessage(e)
        );
        return;
      }

      // 4. WAIT for the INDEPENDENT SOLVER to lock the CBTC counter (htlc_active).
      // The solver daemon verifies our on-chain WBTC lock first, then locks. We do
      // NOT lock or claim here — the user claims as a separate, deliberate step.
      try {
        setStage({ kind: "htlc-locking", quote, swapId: id, secret, lockTx });
        let counterLocked = false;
        for (let i = 0; i < 60; i++) {
          await sleep(3000);
          const { order } = await htlcApi.getOrder(id);
          // LOOP orders skip the Canton counter-lock entirely (custody ordering: the
          // CBTC is delivered at reveal time) — claimable as soon as the WBTC lock
          // is recorded. Managed orders wait for the on-ledger HtlcLock as before.
          if (
            order?.counterMode === "loop" &&
            order?.status === "main_locked"
          ) {
            counterLocked = true;
            break;
          }
          if (
            order?.status === "counter_locked" ||
            order?.status === "counter_claimed" ||
            order?.status === "main_claimed"
          ) {
            counterLocked = true;
            break;
          }
        }
        if (!counterLocked) {
          retry(
            "The solver hasn't locked the CBTC counter yet. Is the solver running? Try again or refund after the timelock."
          );
          return;
        }
        // htlc_active — both legs locked. Now the USER claims.
        setStage({ kind: "htlc-claimable", swapId: id, secret, lockTx });
      } catch (e) {
        retry(`Waiting for the solver failed: ${getSwapErrorMessage(e)}`);
      }
    },
    [evm, expirationSeconds, isParticipantManaged, persistSwapSecret]
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
        const reveal = await htlcApi.claimCounter(swapId, preimage); // reveal → verify → deliver
        if (reveal.delivered) {
          // Preapproval auto-accepted the transfer — the CBTC is ALREADY in the
          // user's Loop wallet. Nothing to sign; record and finish.
          await htlcApi
            .recordClaim(swapId, preimage, reveal.updateId)
            .catch(() => {});
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
        const { command, disclosedContracts, synchronizerId } =
          await htlcApi.prepareAccept(swapId);
        const userParty =
          (provider as { party_id?: string }).party_id ?? wallet.partyId ?? "";
        const result = (await provider.submitAndWaitForTransaction(
          {
            commands: [command],
            disclosedContracts,
            packageIdSelectionPreference: [],
            actAs: [userParty],
            readAs: [userParty],
            synchronizerId
          },
          undefined
        )) as { updateId?: string; transactionTree?: { updateId?: string } };
        const updateId =
          result?.updateId ?? result?.transactionTree?.updateId ?? "submitted";
        // Reveal the preimage to our node so the solver claims the WBTC (the user's
        // standard accept above is their only Canton action).
        await htlcApi.recordClaim(swapId, preimage, updateId);
        forgetSecret(swapId);
        setStage({
          kind: "htlc-done",
          swapId,
          lockTx,
          wbtcAmount: doneAmounts?.wbtcAmount,
          cbtcAmount: doneAmounts?.cbtcAmount
        });
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
      const { secret, hashLock } = generateSecret();
      const id = hashLock;
      const now = Math.floor(Date.now() / 1000);
      const { userTimelock, solverTimelock } = timelocksFromExpiration(
        now,
        expirationSeconds
      );
      try {
        setStage({ kind: "submitting", quote });
        await htlcApi.createOrder({
          id,
          direction: "canton-to-evm",
          hashLock,
          userEvmAddress: evm.account,
          solverEvmAddress: SOLVER_EVM,
          wbtcAmount: wbtcUnits.toString(),
          userTimelock,
          userCantonParty: destinationParty,
          solverCantonParty: SOLVER_CANTON,
          cbtcAmount,
          solverTimelock
        });
        await htlcApi.accept(id);
        await persistSwapSecret(id, secret, {
          direction: "canton-to-evm",
          counterMode: isParticipantManaged ? "managed" : "loop",
          userCantonParty: destinationParty,
          userEvmAddress: evm.account,
          userTimelock,
          solverTimelock
        });
      } catch (e) {
        retry(`Could not create the swap order: ${getSwapErrorMessage(e)}`);
        return;
      }

      try {
        setStage({ kind: "rev-locking", swapId: id, secret });
        if (isParticipantManaged) {
          await htlcApi.lockMain(id);
        } else {
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
          const prep = await htlcApi.prepareLockLoop(id, holdingCids);
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
          let confirmed = false;
          for (let i = 0; i < 10; i++) {
            try {
              await htlcApi.confirmLockLoop(id);
              confirmed = true;
              break;
            } catch {
              await sleep(2000);
            }
          }
          if (!confirmed) {
            retry(
              "Your CBTC allocation was signed but not yet visible on-ledger — reopen this swap from Orders in a moment."
            );
            return;
          }
        }
        let counterLocked = false;
        for (let i = 0; i < 60; i++) {
          await sleep(3000);
          const { order } = await htlcApi.getOrder(id);
          const st = (order as { status?: string } | undefined)?.status;
          if (st === "counter_locked" || st === "counter_claimed") {
            counterLocked = true;
            break;
          }
          if (st === "refunded" || st === "cancelled" || st === "failed") {
            retry(`Swap ${st} while waiting for the solver.`);
            return;
          }
        }
        if (!counterLocked) {
          retry(
            "The solver hasn't locked the WBTC yet. Is the daemon running? Your CBTC auto-refunds after the timelock."
          );
          return;
        }
        setStage({ kind: "rev-claimable", swapId: id, secret });
      } catch (e) {
        retry(getSwapErrorMessage(e));
      }
    },
    [
      evm.account,
      destinationParty,
      expirationSeconds,
      isParticipantManaged,
      wallet,
      persistSwapSecret
    ]
  );

  // REVERSE claim — the user claims the WBTC in MetaMask. This on-chain
  // claim(preimage) IS the secret reveal; the daemon then claims the CBTC.
  const handleClaimReverse = useCallback(
    async (swapId: string, secret: string) => {
      setStage({ kind: "rev-claiming", swapId, secret });
      try {
        const preimage = secretToPreimage(secret);
        const tx = await evmClaim(evm.sendTransaction, HTLC_ESCROW, preimage);
        // Report the reveal (the daemon's EVM watchtower also catches it on its own).
        await htlcApi.recordClaim(swapId, preimage, tx).catch(() => {});
        const { order } = await htlcApi.getOrder(swapId).catch(() => ({
          order: null
        }));
        const doneAmounts = order as
          | { wbtcAmount?: string; cbtcAmount?: string }
          | null;
        forgetSecret(swapId);
        setStage({
          kind: "rev-done",
          swapId,
          claimTx: tx,
          wbtcAmount: doneAmounts?.wbtcAmount,
          cbtcAmount: doneAmounts?.cbtcAmount
        });
      } catch (e) {
        setStage({
          kind: "rev-claimable",
          swapId,
          secret,
          claimError: getSwapErrorMessage(e)
        });
      }
    },
    [evm.sendTransaction]
  );

  // RETAKE (EVM refund) — if a swap is stuck, the user reclaims their locked WBTC
  // by signing retake(hashLock) in MetaMask. Only succeeds after the EVM timelock
  // (the contract enforces TooEarly otherwise). swapId === hashLock.
  const handleRetake = useCallback(
    async (swapId: string) => {
      try {
        const tx = await evmRetake(evm.sendTransaction, HTLC_ESCROW, swapId);
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

  // On first load, if the pending-orders list restored any in-flight swap, focus
  // the most recent one in the detailed view (resume-after-refresh). Runs once,
  // after the list hydrates. Terminal-only lists don't hijack the form.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    if (pendingOrders.length === 0) return;
    resumedRef.current = true;
    const live = pendingOrders.filter((o) => !o.terminal);
    const focus = (live.length ? live : pendingOrders).at(-1);
    if (focus) {
      const id = setTimeout(
        () =>
          setStage({
            kind: "tracking",
            orderId: focus.orderId,
            order: focus.order
          }),
        0
      );
      return () => clearTimeout(id);
    }
  }, [pendingOrders]);

  const focusedOrder =
    stage.kind === "tracking"
      ? (pendingOrders.find((o) => o.orderId === stage.orderId)?.order ??
        stage.order)
      : null;

  // Resume HTLC claim UI after refresh — detect claimable swap but do NOT auto-trigger
  // Loop signMessage; the user unlocks the vault with an explicit click.
  const resumeCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      stage.kind === "htlc-claimable" ||
      stage.kind === "htlc-claiming" ||
      stage.kind === "htlc-resume" ||
      stage.kind === "rev-claimable" ||
      stage.kind === "rev-claiming" ||
      stage.kind === "rev-resume"
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const swapId = readActiveHtlcSwap();
      if (!swapId || resumeCheckedRef.current === swapId) return;
      resumeCheckedRef.current = swapId;
      const { order } = await htlcApi.getOrder(swapId);
      const o = order as {
        status?: string;
        direction?: "evm-to-canton" | "canton-to-evm";
        counterMode?: "managed" | "loop";
        revealedPreimage?: string;
        mainLockTx?: string;
      } | null;
      if (
        !o ||
        !isSwapClaimable({
          status: o.status as SwapStatus,
          direction: o.direction ?? "evm-to-canton",
          counterMode: o.counterMode,
          revealedPreimage: o.revealedPreimage as `0x${string}` | undefined
        })
      ) {
        return;
      }
      if (cancelled) return;
      if (o.direction === "canton-to-evm") {
        setStage({ kind: "rev-resume", swapId });
      } else {
        setStage({ kind: "htlc-resume", swapId, lockTx: o.mainLockTx ?? "" });
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
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
        const secret = await recallSecret(swapId, {
          ...(await vaultRecallContext()),
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
          setStage({ kind: "rev-claimable", swapId, secret });
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
    [vaultRecallContext]
  );

  // --- refund an expired, stuck order (solver submits it; funds → user) ---
  const handleRefundOrder = useCallback(
    async (orderId: string): Promise<string | null> => {
      try {
        const res = await refundOrder(orderId);
        // The pending-orders list polls on its own, so the refunded status will
        // reflect on the next tick — no manual re-poll needed here.
        return res.refundTx ?? null;
      } catch (e) {
        return `__error__:${getSwapErrorMessage(e)}`;
      }
    },
    []
  );

  // NOTE: the CBTC accept is detected AUTOMATICALLY by the solver (accept-watch
  // advances delivering→delivered on its own once the auto-accept lands), so the
  // UI no longer needs a manual "confirm delivery" step. The mandatory auto-accept
  // gate guarantees the accept fires without user action.

  // Return to the swap form. If the focused order is FINISHED, drop it from the
  // list (the receipt is done with). If it's still IN FLIGHT, leave it in the
  // list so it keeps tracking in the "Your swaps" panel — never orphaned.
  const reset = () => {
    if (stage.kind === "tracking") {
      const tracked = pendingOrders.find((o) => o.orderId === stage.orderId);
      if (tracked?.terminal) dismissOrder(stage.orderId);
    }
    setStage({ kind: "idle" });
  };

  // The form (token panels) stays mounted for idle/quoting/error AND while the
  // review modal is open — the modal layers over it (Uniswap "You're swapping"),
  // so the card never visually collapses behind it. Only tracking replaces it.
  const reviewing =
    stage.kind === "quoted" ||
    stage.kind === "approving" ||
    stage.kind === "signing" ||
    stage.kind === "submitting";
  const showForm =
    stage.kind === "idle" ||
    stage.kind === "quoting" ||
    stage.kind === "error" ||
    stage.kind === "htlc-locking" ||
    stage.kind === "rev-locking" ||
    reviewing;
  // "You receive" estimate BEFORE quoting — an APPROXIMATION (shown with "≈").
  // It applies the fee but NOT the live WBTC/BTC price (the browser doesn't have
  // it pre-quote). The EXACT, price-adjusted amount comes from the server quote
  // and is shown in the review modal. So this is a close upper-bound estimate;
  // the real number is slightly lower by WBTC's deviation from 1 BTC.
  const receiveEstimate = (() => {
    if (!amount || !/^\d*\.?\d+$/.test(amount)) return "0";
    try {
      const out = (parseWbtc(amount) * BigInt(10000 - FEE_BPS)) / 10000n;
      return formatWbtc(out);
    } catch {
      return "0";
    }
  })();

  // CoW-style amount validation (TradeFormValidation analogue): compute the
  // amount state once, ordered — the button reflects the FIRST problem.
  //   notSet   → empty or zero  → "Enter an amount" (disabled)
  //   invalid  → parse fails    → "Invalid amount"  (disabled)
  //   overBal  → > balance      → "Insufficient WBTC balance" (disabled)
  const amountState = ((): "ok" | "notSet" | "invalid" | "overBalance" => {
    if (!amount || amount === ".") return "notSet";
    let parsed: bigint;
    try {
      parsed = parseWbtc(amount); // 8dp — same precision for WBTC and CBTC
    } catch {
      return "invalid";
    }
    if (parsed <= 0n) return "notSet";
    if (isReverse) {
      // Selling CBTC — validate against the session party's CBTC balance.
      const cbtcSats = BigInt(Math.round(parseFloat(cbtcBalance || "0") * 1e8));
      if (parsed > cbtcSats) return "overBalance";
      return "ok";
    }
    if (wbtcBalance != null && parsed > wbtcBalance) return "overBalance";
    return "ok";
  })();

  // Single context-aware primary action.
  let primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
  } | null = null;
  if (showForm) {
    if (stage.kind === "htlc-locking") {
      primary = {
        label: "Waiting for solver…",
        onClick: () => {},
        disabled: true,
        busy: true
      };
    } else if (stage.kind === "rev-locking") {
      primary = {
        label: "Locking CBTC",
        onClick: () => {},
        disabled: true,
        busy: true
      };
    } else if (stage.kind === "quoting") {
      primary = {
        label: "Getting quote…",
        onClick: () => {},
        disabled: true,
        busy: true
      };
    } else if (!evm.account) {
      primary = {
        label: evm.available ? "Connect EVM wallet" : "No EVM wallet found",
        onClick: evm.connect,
        disabled: !evm.available
      };
    } else if (wrongChain) {
      primary = {
        label: `Switch to ${SWAP_CHAIN.name}`,
        onClick: handleSwitchChain
      };
    } else if (!loopConnected) {
      primary = {
        label: "Connect Loop wallet",
        onClick: wallet.connectLoop,
        disabled: wallet.loopConnecting || !wallet.loopReady
      };
    } else if (!isParticipantManaged && sessionReady !== true) {
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
    } else if (amountState === "overBalance") {
      primary = {
        label: `Insufficient ${isReverse ? "CBTC" : "WBTC"} balance`,
        onClick: () => {},
        disabled: true
      };
    } else if (isReverse) {
      primary = {
        label: "Review swap",
        onClick: handleQuote,
        disabled: reviewing
      };
    } else {
      // Session ready + amount valid. Review checks auto-accept (no signature)
      // then quotes; if auto-accept is OFF it opens the enable popup.
      primary = {
        label: "Review swap",
        onClick: handleQuote,
        disabled: reviewing
      };
    }
  }

  const showPageTitle =
    stage.kind !== "htlc-done" && stage.kind !== "rev-done";

  return (
    <div className="mx-auto w-full max-w-[460px] px-4 py-6 sm:py-10">
      {showPageTitle && (
        <h1 className="mb-4 px-1 text-2xl font-semibold text-foreground">
          Swap
        </h1>
      )}

      <div className="rounded-3xl border border-foreground/10 bg-card p-4 shadow-sm sm:p-5">
        {showForm && (
          <>
            {/* You pay — WBTC on the source chain */}
            <TokenPanel
              title="You pay"
              token={isReverse ? "CBTC" : "WBTC"}
              network={isReverse ? "Canton" : SWAP_CHAIN.name}
              amount={amount}
              editable
              onAmountChange={setAmount}
              balance={
                isReverse
                  ? loopConnected
                    ? cbtcBalance
                    : undefined
                  : wbtcBalance != null
                    ? formatWbtc(wbtcBalance)
                    : undefined
              }
              onMax={
                isReverse
                  ? cbtcBalance && parseFloat(cbtcBalance) > 0
                    ? () => setAmount(cbtcBalance)
                    : undefined
                  : wbtcBalance != null
                    ? () => setAmount(formatWbtc(wbtcBalance))
                    : undefined
              }
            />

            {/* Direction toggle — flips WBTC→CBTC ↔ CBTC→WBTC. Email sellers lock
                via the on-ledger HtlcLock (trustless); Loop sellers lock via the
                standard Allocation escrow signed in their wallet. */}
            <div className="relative z-10 -my-3 flex justify-center">
              <button
                type="button"
                aria-label="Flip swap direction"
                onClick={() => {
                  setDirection(isReverse ? "evm-to-canton" : "canton-to-evm");
                  setAmount("");
                }}
                title="Flip direction"
                className="flex size-9 items-center justify-center rounded-xl border-4 border-card bg-muted transition-all hover:bg-muted/70 active:scale-95"
              >
                <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                  swap_vert
                </span>
              </button>
            </div>

            {/* You receive */}
            <TokenPanel
              title="You receive"
              token={isReverse ? "WBTC" : "CBTC"}
              network={isReverse ? SWAP_CHAIN.name : "Canton"}
              amount={receiveEstimate}
              editable={false}
              balance={
                isReverse
                  ? wbtcBalance != null
                    ? formatWbtc(wbtcBalance)
                    : undefined
                  : loopConnected
                    ? cbtcBalance
                    : undefined
              }
            />

            {/* Destination + expiration + error + primary action */}
            <div className="px-1 pb-1 pt-3">
              <DetailRow
                label="Recipient"
                value={
                  isReverse
                    ? evm.account
                      ? `${evm.account.slice(0, 8)}…${evm.account.slice(-6)}`
                      : "Connect EVM wallet"
                    : loopConnected
                      ? truncatePartyId(destinationParty)
                      : "Connect Loop wallet"
                }
                ok={isReverse ? !!evm.account : loopConnected}
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
            {wallet.loopError && (
              <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {wallet.loopError}
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

        {stage.kind === "tracking" && (
          <div className="px-1 pb-1 pt-2">
            <TrackingView
              orderId={stage.orderId}
              order={focusedOrder}
              onReset={reset}
              onRefund={handleRefundOrder}
            />
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
              Press Claim to reveal your secret and receive your CBTC. Revealing
              it lets the solver claim the WBTC you locked — this is what makes
              the swap atomic.
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
              Claim the WBTC in MetaMask. The on-chain claim reveals your
              secret, which lets the solver claim the CBTC you locked —
              that&apos;s the atomic link.
            </p>
            {stage.kind === "rev-claimable" && stage.claimError && (
              <p className="mt-2 text-sm text-red-500">⚠️ {stage.claimError}</p>
            )}
            <button
              onClick={() => handleClaimReverse(stage.swapId, stage.secret)}
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
            {/* Stuck-swap escape: refund the locked CBTC (after the Canton timelock).
                Email: backend HtlcLock.Refund. Loop seller: the user signs the
                standard Allocation_Withdraw in their wallet (their unilateral exit). */}
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
            title="Swap complete"
            badge="Claim confirmed"
            description="You claimed your WBTC and revealed the secret on-chain. The solver can now use that same secret to claim the CBTC leg."
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
      </div>

      {/* "Your swaps" — every OTHER tracked order (not the one in the big view).
          CoW keeps all pending orders visible; this is how a swap started while
          another is in flight (or in a second tab) stays trackable, never lost. */}
      {(() => {
        const focusedId = stage.kind === "tracking" ? stage.orderId : null;
        const others = pendingOrders.filter((o) => o.orderId !== focusedId);
        if (others.length === 0) return null;
        return (
          <div className="mt-4 rounded-3xl border border-foreground/10 bg-card p-4 shadow-sm">
            <div className="mb-2 px-1 text-sm font-semibold text-foreground">
              Your swaps
            </div>
            <div className="space-y-1">
              {others.map((o) => (
                <PendingOrderRow
                  key={o.orderId}
                  tracked={o}
                  onView={() =>
                    setStage({
                      kind: "tracking",
                      orderId: o.orderId,
                      order: o.order
                    })
                  }
                  onDismiss={() => dismissOrder(o.orderId)}
                />
              ))}
            </div>
          </div>
        );
      })()}

      {/* Review modal — layers over the card (Uniswap "You're swapping"). Covers
          the quote review and the in-wallet approve/sign/submit steps. */}
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
                  ? stage.quote.direction === "canton-to-evm"
                    ? "Locking CBTC on Canton…"
                    : `Locking WBTC on ${SWAP_CHAIN.name}…`
                  : null
          }
          expirationSeconds={expirationSeconds}
          evmRecipient={evm.account}
          onConfirm={() => {
            if (stage.kind !== "quoted") return;
            if (stage.quote.direction === "canton-to-evm") {
              void handleConfirmReverse(stage.quote);
            } else {
              void handleConfirm(stage.quote);
            }
          }}
          onClose={reset}
        />
      )}

      {/* SIGN PREREQUISITE popup — shown when connected but no JWT session yet.
          Blocks the swap until the user signs once in their Loop wallet. */}
      {loopConnected && sessionReady === false && stage.kind !== "tracking" && (
        <SignGateModal
          signing={signing}
          error={signError}
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
  badge,
  description,
  rows,
  onReset
}: {
  title: string;
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
            <p className="mt-0.5 text-sm text-muted-foreground">
              HTLC reveal complete
            </p>
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
  token,
  network,
  amount,
  editable,
  onAmountChange,
  balance,
  onMax
}: {
  title: string;
  token: string;
  network: string;
  amount: string;
  editable: boolean;
  onAmountChange?: (v: string) => void;
  balance?: string;
  onMax?: () => void;
}) {
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
                  8
                )
              )
            }
            onPaste={(e) => {
              e.preventDefault();
              const cleaned = truncateToDecimals(
                cleanPastedAmount(e.clipboardData.getData("text")),
                8
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
            ) : (
              `≈ ${amount}`
            )}
          </div>
        )}
        <TokenBadge token={token} network={network} />
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

/** A token + network chip (e.g. Arbitrum-mark · WBTC / Arbitrum). */
function TokenBadge({ token, network }: { token: string; network: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full bg-card py-1.5 pl-1.5 pr-3 ring-1 ring-foreground/10">
      <ChainIcon network={network} />
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
  onConfirm,
  onClose
}: {
  quote: QuoteResponse | null;
  retryError?: string;
  busy: string | null;
  expirationSeconds: number;
  evmRecipient: string | null;
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

  if (!quote) return null;

  const reverse = quote.direction === "canton-to-evm";
  const feeBps = quote.feeBps ?? 0;
  const priceScale = 10n ** BigInt(quote.wbtcPriceDecimals ?? 8);
  const priceRaw = quote.wbtcPriceRaw ? BigInt(quote.wbtcPriceRaw) : priceScale;

  const cbtcUnits = BigInt(quote.cbtcAmount);
  const wbtcUnits = BigInt(
    quote.wbtcAmount ?? quote.order.outputs[0]?.amount ?? "0"
  );
  const cbtc = formatWbtc(cbtcUnits);
  const wbtc = formatWbtc(wbtcUnits);

  // Rate labels — CBTC is 1:1 BTC; WBTC trades at P BTC per WBTC.
  const cbtcPerWbtc = formatWbtc((priceRaw * 100_000_000n) / priceScale);
  const wbtcPerCbtc = formatWbtc((100_000_000n * 100_000_000n) / priceRaw);
  const rateLabel = reverse
    ? `1 CBTC = ${wbtcPerCbtc} WBTC`
    : `1 WBTC = ${cbtcPerWbtc} CBTC`;

  // Platform fee on output side.
  const feeLabel = (() => {
    if (feeBps <= 0) return "Free";
    if (reverse) {
      const wbtcBeforeFee = (cbtcUnits * priceRaw) / priceScale;
      const feeAmount = wbtcBeforeFee - wbtcUnits;
      return `${feeBps / 100}% (−${formatWbtc(feeAmount)} WBTC)`;
    }
    const cbtcBeforeFee = (wbtcUnits * priceRaw) / priceScale;
    const feeAmount = cbtcBeforeFee - cbtcUnits;
    return `${feeBps / 100}% (−${formatWbtc(feeAmount)} CBTC)`;
  })();

  const refundAt = new Date(
    (Math.floor(Date.now() / 1000) + expirationSeconds) * 1000
  ).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const recipientLabel = reverse
    ? evmRecipient
      ? `${evmRecipient.slice(0, 8)}…${evmRecipient.slice(-6)}`
      : "Connect EVM wallet"
    : truncatePartyId(quote.cantonParty);

  const payAmount = reverse ? cbtc : wbtc;
  const payToken = reverse ? "CBTC" : "WBTC";
  const payNetwork = reverse ? "Canton" : SWAP_CHAIN.name;
  const receiveAmount = reverse ? wbtc : cbtc;
  const receiveToken = reverse ? "WBTC" : "CBTC";
  const receiveNetwork = reverse ? SWAP_CHAIN.name : "Canton";

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
        <div className="mt-5 flex flex-col gap-1.5 border-t border-foreground/10 pt-4 text-sm">
          <DetailRow label="Rate" value={rateLabel} />
          <DetailRow label="Platform fee" value={feeLabel} />
          <DetailRow
            label="You receive"
            value={`${receiveAmount} ${receiveToken}`}
          />
          <DetailRow label="Recipient" value={recipientLabel} />
          <DetailRow label="Refundable after" value={refundAt} />
        </div>

        {retryError && !busy && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
            {retryError}
          </div>
        )}

        {/* Primary action — turns into an inline progress state while busy. */}
        <button
          onClick={onConfirm}
          disabled={!!busy}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-90"
        >
          {busy ? (
            <>
              <span className="inline-block size-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
              {busy}
            </>
          ) : retryError ? (
            "Try again"
          ) : (
            "Confirm swap"
          )}
        </button>
      </div>
    </div>
  );
}

function TrackingView({
  orderId,
  order,
  onReset,
  onRefund
}: {
  orderId: string;
  order: OrderView | null;
  onReset: () => void;
  onRefund: (orderId: string) => Promise<string | null>;
}) {
  const [refunding, setRefunding] = useState(false);
  const [refundMsg, setRefundMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Tick a clock so "expires in …" and the refund eligibility update live.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Derive the user-facing progress state from the order + live clock — the
  // analogue of CoW's getProgressBarStepName. This applies the grace buffer (no
  // premature "expired") and the delayed threshold (no frozen spinner).
  const progress = order ? deriveProgress(order, now) : "initial";
  const done = progress === "finished";
  const refunded = progress === "refunded";
  const failed = progress === "failed";
  const failedOrRefunded = failed || refunded;
  // Active step in the 3-step user-facing flow.
  const stepIdx = STEP_FOR_PROGRESS[progress];

  // Refund is offered once the order is expired/failed and the WBTC isn't back.
  // Mirror CoW: only after the grace buffer past `expires` (avoid the solver race).
  const expired =
    !!order &&
    now > order.expires + PENDING_BUFFER_SECONDS &&
    !done &&
    !refunded;

  // Amounts for the receipt header (fall back to dashes if not yet loaded).
  const wbtcAmt = order?.wbtcAmount
    ? formatWbtc(BigInt(order.wbtcAmount))
    : null;
  const cbtcAmt = order?.cbtcAmount
    ? formatWbtc(BigInt(order.cbtcAmount))
    : null;

  const doRefund = async () => {
    setRefunding(true);
    setRefundMsg(null);
    const r = await onRefund(orderId);
    setRefunding(false);
    if (r?.startsWith("__error__:")) setRefundMsg(r.slice("__error__:".length));
  };

  // Hero icon/tone per progress state; the title + caption come from PROGRESS_COPY
  // (the single source of CoW-style wording).
  const heroVisual: Record<
    typeof progress,
    { icon: string | null; tone: string; ring: string }
  > = {
    initial: { icon: null, tone: "text-primary", ring: "bg-primary/10" },
    delivering: { icon: null, tone: "text-primary", ring: "bg-primary/10" },
    delayed: { icon: null, tone: "text-primary", ring: "bg-primary/10" },
    finished: {
      icon: "check",
      tone: "text-green-600",
      ring: "bg-green-500/10"
    },
    refunded: {
      icon: "undo",
      tone: "text-on-surface-variant",
      ring: "bg-muted"
    },
    expired: {
      icon: "priority_high",
      tone: "text-destructive",
      ring: "bg-destructive/10"
    },
    failed: {
      icon: "priority_high",
      tone: "text-destructive",
      ring: "bg-destructive/10"
    }
  };
  const hero = { ...heroVisual[progress], ...PROGRESS_COPY[progress] };

  return (
    <div className="flex flex-col gap-4">
      {/* Receipt header — big status + the amounts, styled like a token panel. */}
      <div className="rounded-2xl bg-muted/40 p-4">
        <div className="mb-3 flex items-center gap-3">
          <span
            className={cn(
              "flex size-10 items-center justify-center rounded-full",
              hero.ring
            )}
          >
            {hero.icon ? (
              <span
                className={cn(
                  "material-symbols-outlined text-[24px]",
                  hero.tone
                )}
              >
                {hero.icon}
              </span>
            ) : (
              <span className="inline-block size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            )}
          </span>
          <div>
            <div className="text-base font-semibold text-foreground">
              {hero.title}
            </div>
            {/* CoW-style sub-caption — generic + reassuring, never internal jargon. */}
            <div className="text-xs text-muted-foreground">{hero.caption}</div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-foreground/10 pt-3">
          <span className="text-sm text-muted-foreground">You pay</span>
          <span className="text-sm font-medium text-foreground">
            {wbtcAmt ? `${wbtcAmt} WBTC` : "—"}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">You receive</span>
          <span className="text-sm font-medium text-foreground">
            {cbtcAmt ? `${cbtcAmt} CBTC` : "—"}
          </span>
        </div>
      </div>

      {/* Vertical stepper — THREE user-facing steps (not the internal legs). The
          active step is derived from the backend status via STEP_FOR_STATUS. */}
      <div className="px-1">
        {SWAP_STEPS.map((label, i) => {
          const reached = stepIdx >= i && !failedOrRefunded;
          const completed = reached && (stepIdx > i || done);
          const active = stepIdx === i && !done && !failedOrRefunded;
          const last = i === SWAP_STEPS.length - 1;
          return (
            <div key={label} className="flex gap-3">
              {/* node + rail */}
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors",
                    completed
                      ? "bg-primary text-primary-foreground"
                      : active
                        ? "bg-primary/15 text-primary ring-2 ring-primary"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {completed ? "✓" : i + 1}
                </span>
                {!last && (
                  <span
                    className={cn(
                      "my-0.5 w-0.5 flex-1 rounded-full",
                      stepIdx > i && !failedOrRefunded
                        ? "bg-primary"
                        : "bg-muted"
                    )}
                  />
                )}
              </div>
              {/* label */}
              <div className={cn("pb-4 text-sm", last && "pb-0")}>
                <span
                  className={
                    active
                      ? "font-medium text-foreground"
                      : reached
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }
                >
                  {label}
                </span>
                {active && (
                  <span className="ml-1 animate-pulse text-primary">●</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Success detail. */}
      {done && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-foreground">
          Your CBTC has landed in your Loop wallet and the swap is settled.
        </div>
      )}

      {/* Refunded. */}
      {refunded && (
        <div className="rounded-xl bg-muted/50 p-3 text-sm text-foreground">
          Your WBTC was refunded to your wallet.
        </div>
      )}

      {/* Failed — reassure the WBTC is safe and offer refund if eligible. */}
      {failed && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
          {order?.note ? (
            <div className="text-xs text-muted-foreground">
              Reason: {order.note}
            </div>
          ) : null}
          <div className={order?.note ? "mt-2" : undefined}>
            Your WBTC is still locked in the escrow and is{" "}
            <span className="font-medium">safe</span>.
            {expired
              ? " You can refund it now."
              : order
                ? ` It becomes refundable at ${new Date(order.expires * 1000).toLocaleTimeString()}.`
                : ""}
          </div>
        </div>
      )}

      {/* Stuck-but-not-failed past expiry (e.g. delivered, never finalised). */}
      {!failed && !done && !refunded && expired && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
          This order has passed its deadline without releasing your WBTC. Your
          funds are safe — you can refund them now.
        </div>
      )}

      {/* Refund button when eligible. */}
      {expired && (
        <button
          onClick={doRefund}
          disabled={refunding}
          className="w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
        >
          {refunding ? "Refunding…" : "Refund my WBTC"}
        </button>
      )}
      {refundMsg && (
        <div className="text-xs text-destructive">
          Refund failed: {refundMsg}
        </div>
      )}

      {/* "New swap" — same button in every state. While a swap is still live this
          returns to the form to start ANOTHER swap; the current one keeps tracking
          in the "Your swaps" panel (it isn't abandoned). On a finished swap it
          clears the receipt. Consistent label so the action reads the same. */}
      <button
        onClick={onReset}
        className="w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]"
      >
        New swap
      </button>
    </div>
  );
}

/**
 * A compact row in the "Your swaps" panel — one in-flight (or recently-finished)
 * order that isn't the one in the big detailed view. Shows amount + status, a
 * "View" action to focus it, and a dismiss (×) for finished orders.
 */
function PendingOrderRow({
  tracked,
  onView,
  onDismiss
}: {
  tracked: TrackedOrder;
  onView: () => void;
  onDismiss: () => void;
}) {
  const { order, terminal } = tracked;
  // Lazy-init + tick a clock (Date.now() can't be called during render — it's
  // impure and would break SSR/concurrent rendering).
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const progress = order ? deriveProgress(order, now) : "initial";
  const copy = PROGRESS_COPY[progress];
  const wbtc =
    order?.wbtcAmount != null ? formatWbtc(BigInt(order.wbtcAmount)) : null;

  // Status dot: green = done, red = failed/expired, muted = refunded, spinner-ish
  // amber = in flight.
  const dotClass =
    progress === "finished"
      ? "bg-emerald-500"
      : progress === "failed" || progress === "expired"
        ? "bg-destructive"
        : progress === "refunded"
          ? "bg-muted-foreground"
          : "bg-amber-500";

  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5">
      <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {wbtc ? `${wbtc} WBTC → CBTC` : "Swap"}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {copy.caption}
        </div>
      </div>
      <button
        onClick={onView}
        className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        View
      </button>
      {terminal && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      )}
    </div>
  );
}

/**
 * SIGN PREREQUISITE modal. Before swapping, the user signs ONE message in their
 * Loop wallet so we can read their auto-accept setting + delivery status. This is
 * a prerequisite — shown on entering the swap screen, NOT on the Review click. It
 * can't be dismissed (the swap can't proceed without it); the only action is to
 * sign (or it stays until they do).
 */
function SignGateModal({
  signing,
  error,
  onSign
}: {
  signing: boolean;
  error: string | null;
  onSign: () => void;
}) {
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

        {error && (
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
