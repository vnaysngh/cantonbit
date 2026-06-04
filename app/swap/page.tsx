"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useWallet } from "@/hooks/useWallet";
import { truncatePartyId } from "@/lib/format";
import {
  getQuote, submitOrder, getOrder, refundOrder, isTerminal, STATUS_LABEL,
  type QuoteResponse, type OrderView, type SwapStatus,
} from "@/lib/swap-api";
import {
  PERMIT2_ADDRESS, BASE_SEPOLIA_CHAIN_ID,
  encodeApprove, encodeAllowance, encodeBalanceOf, decodeUint,
  formatWbtc, parseWbtc,
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
const FLOW: SwapStatus[] = ["seen", "delivering", "delivered", "attested", "finalised"];

/** localStorage key for resuming an in-flight order across a page refresh. */
const ACTIVE_ORDER_KEY = "oranj.swap.activeOrder";

export default function SwapPage() {
  const evm = useEvmWallet();
  const wallet = useWallet();

  // DESTINATION party for the delivered cBTC = the user's CONNECTED LOOP WALLET
  // party. Both the Loop wallet and the swap solver run on devnet, so the solver
  // can deliver to it (and the user accepts the incoming cBTC in their own Loop
  // wallet). NEXT_PUBLIC_SWAP_DEST_PARTY remains an optional override for testing
  // against a fixed party.
  const destinationParty = process.env.NEXT_PUBLIC_SWAP_DEST_PARTY ?? wallet.partyId;
  const loopConnected = wallet.isConnected && !!wallet.partyId;

  const [amount, setAmount] = useState("0.0001");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [wbtcBalance, setWbtcBalance] = useState<bigint | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wrongChain = evm.chainId != null && evm.chainId !== BASE_SEPOLIA_CHAIN_ID;

  // --- read WBTC balance once connected + quoted (so we know the token addr) ---
  const refreshBalance = useCallback(async (wbtc: string) => {
    if (!evm.account) return;
    try {
      const bal = decodeUint(await evm.call(wbtc, encodeBalanceOf(evm.account)));
      setWbtcBalance(bal);
    } catch { /* non-fatal */ }
  }, [evm]);

  // --- cleanup polling on unmount ---
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const fail = (message: string) => setStage({ kind: "error", message });

  // --- switch wallet to Base Sepolia (adds the network if unknown) ---
  const handleSwitchChain = useCallback(async () => {
    try {
      await evm.switchChain(BASE_SEPOLIA_CHAIN_ID, {
        chainName: "Base Sepolia",
        rpcUrls: ["https://sepolia.base.org"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: ["https://sepolia.basescan.org"],
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Failed to switch network.");
    }
  }, [evm]);

  // --- 1. quote ---
  const handleQuote = useCallback(async () => {
    if (!evm.account) { fail("Connect your EVM wallet first."); return; }
    if (!destinationParty) { fail("Connect your Loop wallet to set the destination."); return; }
    let wbtcAmount: bigint;
    try { wbtcAmount = parseWbtc(amount); } catch { fail("Enter a valid amount."); return; }
    if (wbtcAmount <= 0n) { fail("Amount must be greater than zero."); return; }

    setStage({ kind: "quoting" });
    try {
      const quote = await getQuote({ user: evm.account, wbtcAmount: wbtcAmount.toString(), cantonParty: destinationParty });
      void refreshBalance(quote.wbtc);
      setStage({ kind: "quoted", quote });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Quote failed.");
    }
  }, [evm.account, destinationParty, amount, refreshBalance]);

  // --- 5. poll status until terminal (defined before handleConfirm, which calls it) ---
  const startTracking = useCallback((orderId: string) => {
    // Persist so a page refresh resumes tracking instead of losing the order.
    try { localStorage.setItem(ACTIVE_ORDER_KEY, orderId); } catch { /* ignore */ }
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
      } catch { /* keep polling */ }
    };
    void tick();
    pollRef.current = setInterval(tick, 4000);
  }, []);

  // --- 2. approve (if needed) + 3. sign + 4. submit ---
  // Recoverable failures (rejected approve/sign, transient submit) return to the
  // `quoted` stage with a retryError so the user can retry WITHOUT re-quoting.
  const handleConfirm = useCallback(async (quote: QuoteResponse) => {
    const retry = (msg: string) => setStage({ kind: "quoted", quote, retryError: msg });
    if (!evm.account) { retry("Wallet disconnected — reconnect and try again."); return; }
    const needed = BigInt(quote.order.inputs[0][1]);

    // 2. ensure Permit2 allowance
    try {
      const allowance = decodeUint(await evm.call(quote.wbtc, encodeAllowance(evm.account, PERMIT2_ADDRESS)));
      if (allowance < needed) {
        setStage({ kind: "approving", quote });
        const txHash = await evm.sendTransaction({ to: quote.wbtc, data: encodeApprove(PERMIT2_ADDRESS) });
        // Best-effort wait: poll the allowance until it reflects (or timeout).
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const a = decodeUint(await evm.call(quote.wbtc, encodeAllowance(evm.account, PERMIT2_ADDRESS)));
          if (a >= needed) break;
          if (i === 29) throw new Error(`approve tx ${txHash} not yet reflected`);
        }
      }
    } catch (e) {
      retry(isUserReject(e) ? "Approval cancelled. Approve WBTC to continue." : `Approve failed: ${errMsg(e)}`);
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
          { name: "verifyingContract", type: "address" },
        ],
        ...quote.permit2.types,
      };
      signature = await evm.signTypedData({
        domain: quote.permit2.domain,
        types: typesWithDomain,
        primaryType: quote.permit2.primaryType,
        message: quote.permit2.message,
      });
    } catch (e) {
      retry(isUserReject(e) ? "Signature cancelled. Sign to lock your WBTC and start the swap." : `Signature failed: ${errMsg(e)}`);
      return;
    }

    // 4. submit to the solver (it submits openFor on Base)
    try {
      setStage({ kind: "submitting", quote });
      const { orderId } = await submitOrder({ order: quote.order, signature, cantonParty: quote.cantonParty });
      startTracking(orderId);
    } catch (e) {
      // Submit failure is rarely user-recoverable (already-signed), so surface it
      // but keep the quote so they can retry the submit.
      retry(`Couldn't submit the swap: ${errMsg(e)}. Try again.`);
    }
  }, [evm, startTracking]);

  // Resume tracking an in-flight order across a page refresh. Deferred to a
  // microtask so startTracking's setState doesn't run synchronously in the effect.
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(ACTIVE_ORDER_KEY); } catch { /* ignore */ }
    if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) {
      const id = setTimeout(() => startTracking(saved!), 0);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- refund an expired, stuck order (solver submits it; funds → user) ---
  const handleRefundOrder = useCallback(async (orderId: string): Promise<string | null> => {
    try {
      const res = await refundOrder(orderId);
      // Re-poll once to reflect the refunded status.
      const order = await getOrder(orderId).catch(() => null);
      if (order) setStage({ kind: "tracking", orderId, order });
      return res.refundTx ?? null;
    } catch (e) {
      return `__error__:${errMsg(e)}`;
    }
  }, []);

  const reset = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    try { localStorage.removeItem(ACTIVE_ORDER_KEY); } catch { /* ignore */ }
    setStage({ kind: "idle" });
  };

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Swap</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Swap WBTC on Base for cBTC on Canton. One solver fronts the cBTC; your
          WBTC is locked in an audited escrow and refundable if delivery fails.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>WBTC → cBTC</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* Connection row */}
          <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 text-sm">
            <ConnectionRow
              label="Canton (destination)"
              value={destinationParty ? truncatePartyId(destinationParty) : "Connect Loop wallet"}
              ok={loopConnected}
              action={
                !loopConnected ? (
                  <Button
                    size="sm" variant="outline"
                    onClick={wallet.connectLoop}
                    disabled={wallet.loopConnecting || !wallet.loopReady}
                  >
                    {wallet.loopConnecting ? "Connecting…" : wallet.loopReady ? "Connect Loop" : "Loading…"}
                  </Button>
                ) : undefined
              }
            />
            <p className="text-[11px] text-muted-foreground -mt-1">
              cBTC is delivered to your connected Loop wallet — accept the incoming
              transfer there once it arrives.
            </p>
            {wallet.loopError && (
              <p className="text-[11px] text-destructive -mt-1">{wallet.loopError}</p>
            )}
            <ConnectionRow
              label="EVM (source)"
              value={evm.account ? `${evm.account.slice(0, 6)}…${evm.account.slice(-4)}` : "Not connected"}
              ok={!!evm.account && !wrongChain}
              action={
                !evm.account ? (
                  <Button size="sm" variant="outline" onClick={evm.connect} disabled={evm.connecting || !evm.available}>
                    {evm.connecting ? "Connecting…" : evm.available ? "Connect" : "No wallet"}
                  </Button>
                ) : undefined
              }
            />
            {wrongChain && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-destructive">
                  Wrong network — your wallet reports chain {evm.chainId}, but this swap needs
                  Base Sepolia (chain {BASE_SEPOLIA_CHAIN_ID}).
                </p>
                <Button size="sm" variant="outline" onClick={handleSwitchChain}>
                  Switch to Base Sepolia
                </Button>
              </div>
            )}
          </div>

          {/* Amount */}
          {(stage.kind === "idle" || stage.kind === "quoting" || stage.kind === "error") && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="amount">Amount (WBTC)</Label>
              <Input
                id="amount" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0001"
              />
              {wbtcBalance != null && (
                <p className="text-xs text-muted-foreground">Balance: {formatWbtc(wbtcBalance)} WBTC</p>
              )}
              <p className="text-xs text-muted-foreground">You receive ≈ {amount || "0"} cBTC — exact amount shown in the quote</p>
            </div>
          )}

          {/* Stage-driven body */}
          {stage.kind === "error" && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {stage.message}
            </div>
          )}

          {(stage.kind === "idle" || stage.kind === "error" || stage.kind === "quoting") && (
            <Button
              onClick={handleQuote}
              disabled={stage.kind === "quoting" || !evm.account || !destinationParty || wrongChain}
            >
              {stage.kind === "quoting" ? "Getting quote…" : "Get quote"}
            </Button>
          )}

          {stage.kind === "quoted" && (
            <QuoteSummary
              quote={stage.quote}
              retryError={stage.retryError}
              onConfirm={() => handleConfirm(stage.quote)}
              onCancel={reset}
            />
          )}

          {(stage.kind === "approving" || stage.kind === "signing" || stage.kind === "submitting") && (
            <BusyStep
              label={
                stage.kind === "approving" ? "Approve WBTC in your wallet…" :
                stage.kind === "signing" ? "Sign the swap in your wallet…" :
                "Locking WBTC on Base…"
              }
            />
          )}

          {stage.kind === "tracking" && (
            <TrackingView
              orderId={stage.orderId}
              order={stage.order}
              onReset={reset}
              onRefund={handleRefundOrder}
            />
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Two-legged settlement — not atomic. If the solver never delivers, your
        WBTC is refundable after the order expires.
      </p>
    </div>
  );
}

function ConnectionRow({ label, value, ok, action }: { label: string; value: string; ok: boolean; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className={ok ? "text-foreground" : "text-muted-foreground"}>{value}</span>
        <span className={`inline-block size-2 rounded-full ${ok ? "bg-green-500" : "bg-muted-foreground/40"}`} />
        {action}
      </div>
    </div>
  );
}

function QuoteSummary({ quote, retryError, onConfirm, onCancel }: { quote: QuoteResponse; retryError?: string; onConfirm: () => void; onCancel: () => void }) {
  const wbtc = formatWbtc(BigInt(quote.order.inputs[0][1]));
  const cbtc = formatWbtc(BigInt(quote.cbtcAmount));
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-foreground/10 p-3 text-sm">
        <Row label="You send" value={`${wbtc} WBTC`} />
        <Row label="You receive" value={`${cbtc} cBTC`} />
        <Row
          label="Rate"
          value={quote.feeBps > 0 ? `1:1 − ${quote.feeBps / 100}% fee` : "1:1 (no fee)"}
        />
        <Row label="To party" value={truncatePartyId(quote.cantonParty)} />
        <Row label="Refund after" value={new Date(quote.expires * 1000).toLocaleString()} />
      </div>
      {retryError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
          {retryError}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onCancel}>Back</Button>
        <Button className="flex-1" onClick={onConfirm}>
          {retryError ? "Try again" : "Confirm swap"}
        </Button>
      </div>
    </div>
  );
}

function BusyStep({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-4 text-sm">
      <span className="inline-block size-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
      {label}
    </div>
  );
}

function TrackingView({ orderId, order, onReset, onRefund }: {
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

  const status = order?.status;
  const done = status === "finalised";
  const refunded = status === "refunded";
  const failed = status === "failed";
  const failedOrRefunded = failed || refunded;
  const currentIdx = status ? FLOW.indexOf(status) : 0;

  // The order is past its refund window and the WBTC hasn't been released.
  const expired = !!order && now > order.expires && !done && !refunded;
  // The user must accept the incoming cBTC in their Loop wallet while delivering.
  const awaitingAccept = status === "delivering";

  const doRefund = async () => {
    setRefunding(true);
    setRefundMsg(null);
    const r = await onRefund(orderId);
    setRefunding(false);
    if (r?.startsWith("__error__:")) setRefundMsg(r.slice("__error__:".length));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {FLOW.map((s, i) => {
          const reached = currentIdx >= i && !failedOrRefunded;
          const active = currentIdx === i && !done && !failedOrRefunded;
          return (
            <div key={s} className="flex items-center gap-3 text-sm">
              <span className={`inline-flex size-5 items-center justify-center rounded-full text-xs ${reached ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {reached && currentIdx > i ? "✓" : i + 1}
              </span>
              <span className={active ? "font-medium text-foreground" : reached ? "text-foreground" : "text-muted-foreground"}>
                {STATUS_LABEL[s]}
                {active && <span className="ml-1 animate-pulse">…</span>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Action prompt: the user must accept the cBTC in their Loop wallet. */}
      {awaitingAccept && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
          <span className="font-medium">Accept the incoming cBTC in your Loop wallet</span>
          {" — "}the swap completes once you do. Open your Loop wallet to confirm the transfer.
        </div>
      )}

      {/* Success. */}
      {done && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-foreground">
          ✓ Swap complete — cBTC delivered to your Loop wallet.
          {order?.finaliseTxHash && (
            <div className="mt-1 break-all text-xs text-muted-foreground">finalise: {order.finaliseTxHash}</div>
          )}
        </div>
      )}

      {/* Refunded. */}
      {refunded && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm text-foreground">
          Your WBTC was refunded to your wallet.
        </div>
      )}

      {/* Failed — reassure the WBTC is safe and offer refund if eligible. */}
      {failed && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
          <span className="font-medium text-destructive">This swap didn’t complete.</span>
          {order?.note ? <div className="mt-1 text-xs text-muted-foreground">Reason: {order.note}</div> : null}
          <div className="mt-2">
            Your WBTC is still locked in the escrow and is <span className="font-medium">safe</span>.
            {expired
              ? " You can refund it now."
              : order ? ` It becomes refundable at ${new Date(order.expires * 1000).toLocaleTimeString()}.` : ""}
          </div>
        </div>
      )}

      {/* Stuck-but-not-failed past expiry (e.g. delivered, never finalised). */}
      {!failed && !done && !refunded && expired && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
          This order has passed its deadline without releasing your WBTC. Your funds
          are safe — you can refund them now.
        </div>
      )}

      {/* Refund button when eligible. */}
      {expired && (
        <Button onClick={doRefund} disabled={refunding}>
          {refunding ? "Refunding…" : "Refund my WBTC"}
        </Button>
      )}
      {refundMsg && <div className="text-xs text-destructive">Refund failed: {refundMsg}</div>}

      <div className="break-all text-xs text-muted-foreground">order: {orderId}</div>

      {(done || refunded || failed) && (
        <Button variant="outline" onClick={onReset}>New swap</Button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** EIP-1193 user-rejection (code 4001) or common reject phrasings. */
function isUserReject(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  if (code === 4001) return true;
  const m = errMsg(e).toLowerCase();
  return m.includes("user rejected") || m.includes("user denied") || m.includes("rejected the request");
}
