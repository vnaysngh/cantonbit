"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChainIcon } from "@/components/ChainIcon";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWallet";
import { useBalance } from "@/hooks/useBalance";
import { truncatePartyId } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  getQuote,
  submitOrder,
  getOrder,
  refundOrder,
  isTerminal,
  STATUS_LABEL,
  type QuoteResponse,
  type OrderView,
  type SwapStatus
} from "@/lib/swap-api";
import {
  PERMIT2_ADDRESS,
  SWAP_CHAIN,
  encodeApprove,
  encodeAllowance,
  encodeBalanceOf,
  decodeUint,
  formatWbtc,
  parseWbtc
} from "@/lib/swap-evm";

type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  // `retryError` lets a rejected approve/sign return to the quote (don't lose it).
  | { kind: "quoted"; quote: QuoteResponse; retryError?: string }
  | { kind: "approving"; quote: QuoteResponse }
  | { kind: "signing"; quote: QuoteResponse }
  | { kind: "submitting"; quote: QuoteResponse }
  | { kind: "tracking"; orderId: string; order: OrderView | null }
  | { kind: "error"; message: string };

/** The ordered set of statuses for the progress display. */
const FLOW: SwapStatus[] = [
  "seen",
  "delivering",
  "delivered",
  "attested",
  "finalised"
];

/** localStorage key for resuming an in-flight order across a page refresh. */
const ACTIVE_ORDER_KEY = "oranj.swap.activeOrder";

export default function SwapPage() {
  const evm = useEvmWallet();
  const wallet = useWallet();

  // DESTINATION party for the delivered CBTC = the user's CONNECTED LOOP WALLET
  // party. Both the Loop wallet and the swap solver run on devnet, so the solver
  // can deliver to it (and the user accepts the incoming CBTC in their own Loop
  // wallet). NEXT_PUBLIC_SWAP_DEST_PARTY remains an optional override for testing
  // against a fixed party.
  const destinationParty =
    process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ?? wallet.partyId;
  const loopConnected = wallet.isConnected && !!wallet.partyId;

  const [amount, setAmount] = useState("0.0001");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [wbtcBalance, setWbtcBalance] = useState<bigint | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // CBTC balance from the connected Loop wallet (for the "You receive" panel).
  const { total: cbtcBalance } = useBalance();

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
    return () => { cancelled = true; };
  }, [evm.account, wrongChain, refreshBalance]);

  // --- cleanup polling on unmount ---
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

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

  // --- 1. quote ---
  const handleQuote = useCallback(async () => {
    if (!evm.account) {
      fail("Connect your EVM wallet first.");
      return;
    }
    if (!destinationParty) {
      fail("Connect your Loop wallet to set the destination.");
      return;
    }
    let wbtcAmount: bigint;
    try {
      wbtcAmount = parseWbtc(amount);
    } catch {
      fail("Enter a valid amount.");
      return;
    }
    if (wbtcAmount <= 0n) {
      fail("Amount must be greater than zero.");
      return;
    }

    setStage({ kind: "quoting" });
    try {
      const quote = await getQuote({
        user: evm.account,
        wbtcAmount: wbtcAmount.toString(),
        cantonParty: destinationParty
      });
      void refreshBalance(quote.wbtc);
      setStage({ kind: "quoted", quote });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Quote failed.");
    }
  }, [evm.account, destinationParty, amount, refreshBalance]);

  // --- 5. poll status until terminal (defined before handleConfirm, which calls it) ---
  const startTracking = useCallback((orderId: string) => {
    // Persist so a page refresh resumes tracking instead of losing the order.
    try {
      localStorage.setItem(ACTIVE_ORDER_KEY, orderId);
    } catch {
      /* ignore */
    }
    setStage({ kind: "tracking", orderId, order: null });
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const order = await getOrder(orderId);
        setStage({ kind: "tracking", orderId, order });
        if (isTerminal(order.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 4000);
  }, []);

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
      const needed = BigInt(quote.order.inputs[0][1]);

      // 2. ensure Permit2 allowance
      try {
        const allowance = decodeUint(
          await evm.call(
            quote.wbtc,
            encodeAllowance(evm.account, PERMIT2_ADDRESS)
          )
        );
        if (allowance < needed) {
          setStage({ kind: "approving", quote });
          const txHash = await evm.sendTransaction({
            to: quote.wbtc,
            data: encodeApprove(PERMIT2_ADDRESS)
          });
          // Best-effort wait: poll the allowance until it reflects (or timeout).
          for (let i = 0; i < 30; i++) {
            await sleep(2000);
            const a = decodeUint(
              await evm.call(
                quote.wbtc,
                encodeAllowance(evm.account, PERMIT2_ADDRESS)
              )
            );
            if (a >= needed) break;
            if (i === 29)
              throw new Error(`approve tx ${txHash} not yet reflected`);
          }
        }
      } catch (e) {
        retry(
          isUserReject(e)
            ? "Approval cancelled. Approve WBTC to continue."
            : `Approve failed: ${errMsg(e)}`
        );
        return;
      }

      // 3. sign the Permit2 witness.
      // eth_signTypedData_v4 requires EIP712Domain to be declared in `types`
      // (viem's signer auto-injects it, but raw wallet RPC does not). Declare it
      // to match the domain fields the API sent (name, chainId, verifyingContract),
      // or the wallet signs a different digest → Permit2 reverts InvalidSigner.
      let signature: string;
      try {
        setStage({ kind: "signing", quote });
        const typesWithDomain = {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" }
          ],
          ...quote.permit2.types
        };
        signature = await evm.signTypedData({
          domain: quote.permit2.domain,
          types: typesWithDomain,
          primaryType: quote.permit2.primaryType,
          message: quote.permit2.message
        });
      } catch (e) {
        retry(
          isUserReject(e)
            ? "Signature cancelled. Sign to lock your WBTC and start the swap."
            : `Signature failed: ${errMsg(e)}`
        );
        return;
      }

      // 4. submit to the solver (it submits openFor on Base)
      try {
        setStage({ kind: "submitting", quote });
        const { orderId } = await submitOrder({
          order: quote.order,
          signature,
          cantonParty: quote.cantonParty
        });
        startTracking(orderId);
      } catch (e) {
        // Submit failure is rarely user-recoverable (already-signed), so surface it
        // but keep the quote so they can retry the submit.
        retry(`Couldn't submit the swap: ${errMsg(e)}. Try again.`);
      }
    },
    [evm, startTracking]
  );

  // Resume tracking an in-flight order across a page refresh. Deferred to a
  // microtask so startTracking's setState doesn't run synchronously in the effect.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(ACTIVE_ORDER_KEY);
    } catch {
      /* ignore */
    }
    if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) {
      const id = setTimeout(() => startTracking(saved!), 0);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- refund an expired, stuck order (solver submits it; funds → user) ---
  const handleRefundOrder = useCallback(
    async (orderId: string): Promise<string | null> => {
      try {
        const res = await refundOrder(orderId);
        // Re-poll once to reflect the refunded status.
        const order = await getOrder(orderId).catch(() => null);
        if (order) setStage({ kind: "tracking", orderId, order });
        return res.refundTx ?? null;
      } catch (e) {
        return `__error__:${errMsg(e)}`;
      }
    },
    []
  );

  const reset = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    try {
      localStorage.removeItem(ACTIVE_ORDER_KEY);
    } catch {
      /* ignore */
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
    reviewing;
  const receiveEstimate = amount && /^\d*\.?\d+$/.test(amount) ? amount : "0";

  // Single context-aware primary action.
  let primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  } | null = null;
  if (showForm) {
    if (!evm.account) {
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
    } else {
      primary = {
        label: stage.kind === "quoting" ? "Getting quote…" : "Review swap",
        onClick: handleQuote,
        disabled: stage.kind === "quoting" || reviewing || !amount
      };
    }
  }

  return (
    <div className="mx-auto w-full max-w-[460px] px-4 py-10">
      <h1 className="mb-4 px-1 text-2xl font-semibold text-foreground">Swap</h1>

      <div className="rounded-3xl border border-foreground/10 bg-card p-3 shadow-sm">
        {showForm && (
          <>
            {/* You pay — WBTC on the source chain */}
            <TokenPanel
              title="You pay"
              token="WBTC"
              network={SWAP_CHAIN.name}
              amount={amount}
              editable
              onAmountChange={setAmount}
              balance={
                wbtcBalance != null ? formatWbtc(wbtcBalance) : undefined
              }
              onMax={
                wbtcBalance != null
                  ? () => setAmount(formatWbtc(wbtcBalance))
                  : undefined
              }
            />

            {/* Direction arrow (decorative — this swap is one-directional) */}
            <div className="relative z-10 -my-3 flex justify-center">
              <div className="flex size-9 items-center justify-center rounded-xl border-4 border-card bg-muted">
                <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                  arrow_downward
                </span>
              </div>
            </div>

            {/* You receive — CBTC on Canton */}
            <TokenPanel
              title="You receive"
              token="CBTC"
              network="Canton"
              amount={receiveEstimate}
              editable={false}
              balance={loopConnected ? cbtcBalance : undefined}
            />

            {/* Destination + error + primary action */}
            <div className="px-1 pb-1 pt-3">
              <DetailRow
                label="Recipient"
                value={
                  loopConnected
                    ? truncatePartyId(destinationParty)
                    : "Connect Loop wallet"
                }
                ok={loopConnected}
              />
            </div>

            {stage.kind === "error" && (
              <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {stage.message}
              </div>
            )}
            {wallet.loopError && (
              <div className="mb-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {wallet.loopError}
              </div>
            )}

            {primary && (
              <button
                onClick={primary.onClick}
                disabled={primary.disabled}
                className="mt-1 w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
              >
                {primary.label}
              </button>
            )}
          </>
        )}

        {stage.kind === "tracking" && (
          <div className="px-1 pb-1 pt-2">
            <TrackingView
              orderId={stage.orderId}
              order={stage.order}
              onReset={reset}
              onRefund={handleRefundOrder}
            />
          </div>
        )}
      </div>

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
                  ? `Locking WBTC on ${SWAP_CHAIN.name}…`
                  : null
          }
          onConfirm={() =>
            stage.kind === "quoted" && handleConfirm(stage.quote)
          }
          onClose={reset}
        />
      )}
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
    <div className="rounded-2xl bg-muted/40 p-4">
      <div className="mb-1 text-sm text-muted-foreground">{title}</div>
      <div className="flex items-center justify-between gap-3">
        {editable ? (
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange?.(e.target.value)}
            placeholder="0.0"
            className="w-full min-w-0 bg-transparent text-3xl font-medium text-foreground outline-none placeholder:text-on-surface-variant/40"
          />
        ) : (
          <div className="w-full min-w-0 truncate text-3xl font-medium text-foreground">
            {amount === "0" ? (
              <span className="text-on-surface-variant/40">0.0</span>
            ) : (
              `≈ ${amount}`
            )}
          </div>
        )}
        <TokenBadge token={token} network={network} />
      </div>
      {(balance !== undefined || onMax) && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {balance !== undefined && <span>Balance: {balance}</span>}
          {onMax && (
            <button
              onClick={onMax}
              className="font-semibold text-primary hover:opacity-80"
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
  onConfirm,
  onClose
}: {
  quote: QuoteResponse | null;
  retryError?: string;
  busy: string | null;
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

  const wbtc = formatWbtc(BigInt(quote.order.inputs[0][1]));
  const cbtc = formatWbtc(BigInt(quote.cbtcAmount));
  const feePct = quote.feeBps > 0 ? `${quote.feeBps / 100}%` : "Free";
  const refundAt = new Date(quote.expires * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

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
            <div className="text-3xl font-medium text-foreground">{wbtc} WBTC</div>
            <TokenBadge token="WBTC" network={SWAP_CHAIN.name} />
          </div>
          <div className="my-2 pl-1 text-on-surface-variant">
            <span className="material-symbols-outlined text-[22px]">arrow_downward</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-3xl font-medium text-foreground">{cbtc} CBTC</div>
            <TokenBadge token="CBTC" network="Canton" />
          </div>
        </div>

        {/* Trade details */}
        <div className="mt-5 flex flex-col gap-1.5 border-t border-foreground/10 pt-4 text-sm">
          <DetailRow label="Rate" value="1 WBTC = 1 CBTC" />
          <DetailRow label="Fee" value={feePct} />
          <DetailRow label="Recipient" value={truncatePartyId(quote.cantonParty)} />
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
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Tick a clock so "expires in …" and the refund eligibility update live.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const status = order?.status;
  const done = status === "finalised";
  const refunded = status === "refunded";
  const failed = status === "failed";
  const failedOrRefunded = failed || refunded;
  const currentIdx = status ? FLOW.indexOf(status) : 0;

  // The order is past its refund window and the WBTC hasn't been released.
  const expired = !!order && now > order.expires && !done && !refunded;
  // The user must accept the incoming CBTC in their Loop wallet while delivering.
  const awaitingAccept = status === "delivering";

  // Amounts for the receipt header (fall back to dashes if not yet loaded).
  const wbtcAmt = order?.wbtcAmount ? formatWbtc(BigInt(order.wbtcAmount)) : null;
  const cbtcAmt = order?.cbtcAmount ? formatWbtc(BigInt(order.cbtcAmount)) : null;

  const doRefund = async () => {
    setRefunding(true);
    setRefundMsg(null);
    const r = await onRefund(orderId);
    setRefunding(false);
    if (r?.startsWith("__error__:")) setRefundMsg(r.slice("__error__:".length));
  };

  const copyOrder = () => {
    void navigator.clipboard.writeText(orderId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Hero state: icon, ring color, and headline that summarizes the whole swap.
  const hero = done
    ? { icon: "check", tone: "text-green-600", ring: "bg-green-500/10", title: "Swap complete" }
    : refunded
      ? { icon: "undo", tone: "text-on-surface-variant", ring: "bg-muted", title: "Refunded" }
      : failed
        ? { icon: "priority_high", tone: "text-destructive", ring: "bg-destructive/10", title: "Swap didn’t complete" }
        : { icon: null, tone: "text-primary", ring: "bg-primary/10", title: "Swapping…" };

  return (
    <div className="flex flex-col gap-4">
      {/* Receipt header — big status + the amounts, styled like a token panel. */}
      <div className="rounded-2xl bg-muted/40 p-4">
        <div className="mb-3 flex items-center gap-3">
          <span className={cn("flex size-10 items-center justify-center rounded-full", hero.ring)}>
            {hero.icon ? (
              <span className={cn("material-symbols-outlined text-[24px]", hero.tone)}>
                {hero.icon}
              </span>
            ) : (
              <span className="inline-block size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            )}
          </span>
          <div>
            <div className="text-base font-semibold text-foreground">{hero.title}</div>
            {status && (
              <div className="text-xs text-muted-foreground">{STATUS_LABEL[status]}</div>
            )}
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

      {/* Vertical stepper with a connecting rail. */}
      <div className="px-1">
        {FLOW.map((s, i) => {
          const reached = currentIdx >= i && !failedOrRefunded;
          const completed = reached && (currentIdx > i || done);
          const active = currentIdx === i && !done && !failedOrRefunded;
          const last = i === FLOW.length - 1;
          return (
            <div key={s} className="flex gap-3">
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
                      currentIdx > i && !failedOrRefunded ? "bg-primary" : "bg-muted"
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
                  {STATUS_LABEL[s]}
                </span>
                {active && <span className="ml-1 animate-pulse text-primary">●</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action prompt: the user must accept the CBTC in their Loop wallet. */}
      {awaitingAccept && (
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
          <span className="font-medium">
            Accept the incoming CBTC in your Loop wallet
          </span>
          {" — "}the swap completes once you do. Open your Loop wallet to
          confirm the transfer.
        </div>
      )}

      {/* Success detail. */}
      {done && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-foreground">
          Your WBTC is settled and the CBTC has been sent to your Loop wallet.
          <div className="mt-1 text-xs text-muted-foreground">
            Open your Loop wallet and{" "}
            <span className="font-medium">accept the incoming CBTC</span> if it
            isn’t auto-accepted.
          </div>
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
            <div className="text-xs text-muted-foreground">Reason: {order.note}</div>
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
        <div className="text-xs text-destructive">Refund failed: {refundMsg}</div>
      )}

      {(done || refunded || failed) && (
        <button
          onClick={onReset}
          className="w-full rounded-2xl bg-primary py-4 text-base font-semibold text-on-primary transition-all hover:opacity-90 active:scale-[0.99]"
        >
          New swap
        </button>
      )}

      {/* Order id — truncated + copyable, plus a quiet escape hatch while live. */}
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <button onClick={copyOrder} className="font-mono hover:text-foreground" title="Copy order id">
          {copied ? "Copied!" : `Order ${orderId.slice(0, 6)}…${orderId.slice(-4)}`}
        </button>
        {!done && !refunded && !failed && (
          <button onClick={onReset} className="hover:text-foreground">
            Start over
          </button>
        )}
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** EIP-1193 user-rejection (code 4001) or common reject phrasings. */
function isUserReject(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  if (code === 4001) return true;
  const m = errMsg(e).toLowerCase();
  return (
    m.includes("user rejected") ||
    m.includes("user denied") ||
    m.includes("rejected the request")
  );
}
